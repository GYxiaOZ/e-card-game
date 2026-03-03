/**
 * E-Card 多人游戏服务器 - 筹码制
 * 使用 Socket.IO 实现实时对战
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// 创建 Express 应用和 HTTP 服务器
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// 提供静态文件
app.use(express.static(path.join(__dirname)));

/**
 * 游戏状态枚举
 * @enum {string}
 */
const GameStatus = {
  WAITING: 'waiting', // 等待玩家
  READY: 'ready', // 准备就绪
  PLAYING: 'playing', // 游戏中
  FINISHED: 'finished', // 已结束
};

/**
 * 小局状态枚举
 * @enum {string}
 */
const RoundStatus = {
  BETTING: 'betting', // 下注阶段
  PLAYING: 'playing', // 出牌阶段
  REVEALING: 'revealing', // 开牌阶段
  FINISHED: 'finished', // 小局结束
};

/**
 * 卡牌配置
 * @type {Object.<string, {name: string, icon: string, type: string}>}
 */
const CARDS = {
  KING: { name: '国王', icon: '👑', type: 'KING' },
  SLAVE: { name: '奴隶', icon: '⛓️', type: 'SLAVE' },
  CIVILIAN: { name: '平民', icon: '👨', type: 'CIVILIAN' },
};

// 游戏房间存储
const rooms = new Map();

// 初始筹码
const INITIAL_CHIPS = 200;

// 回合倒计时时间（毫秒）
const TURN_TIMEOUT = 20000;

/**
 * 生成随机房间ID
 * @returns {string} 6位房间号
 */
function generateRoomId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 生成卡组
 * @param {string} type - 阵营类型 ('KING' | 'SLAVE')
 * @returns {Array} 随机排序的卡牌数组
 */
function generateDeck(type) {
  const deck = [
    { ...CARDS.CIVILIAN },
    { ...CARDS.CIVILIAN },
    { ...CARDS.CIVILIAN },
    { ...CARDS.CIVILIAN },
    type === 'KING' ? { ...CARDS.KING } : { ...CARDS.SLAVE },
  ];
  return deck.sort(() => Math.random() - 0.5);
}

/**
 * 比较两张卡牌
 * @param {Object} p1Card - 玩家1的卡牌
 * @param {Object} p2Card - 玩家2的卡牌
 * @returns {string} 结果 ('PLAYER1_WIN' | 'PLAYER2_WIN' | 'DRAW')
 */
function compareCards(p1Card, p2Card) {
  if (p1Card.type === p2Card.type) return 'DRAW';
  if (p1Card.type === 'KING' && p2Card.type === 'CIVILIAN') return 'PLAYER1_WIN';
  if (p2Card.type === 'KING' && p1Card.type === 'CIVILIAN') return 'PLAYER2_WIN';
  if (p1Card.type === 'SLAVE' && p2Card.type === 'KING') return 'PLAYER1_WIN';
  if (p2Card.type === 'SLAVE' && p1Card.type === 'KING') return 'PLAYER2_WIN';
  if (p1Card.type === 'CIVILIAN' && p2Card.type === 'SLAVE') return 'PLAYER1_WIN';
  if (p2Card.type === 'CIVILIAN' && p1Card.type === 'SLAVE') return 'PLAYER2_WIN';
  return 'DRAW';
}

/**
 * 获取对手ID
 * @param {Object} room - 房间对象
 * @param {string} playerId - 玩家ID
 * @returns {string|null} 对手ID
 */
function getOpponentId(room, playerId) {
  for (const id of room.players.keys()) {
    if (id !== playerId) return id;
  }
  return null;
}

/**
 * 开始回合倒计时
 * @param {Object} room - 房间对象
 */
function startTurnTimer(room) {
  // 清除之前的定时器
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  // 设置截止时间
  room.turnDeadline = Date.now() + TURN_TIMEOUT;

  // 广播倒计时开始
  io.to(room.id).emit('turn-timer-start', {
    deadline: room.turnDeadline,
    duration: TURN_TIMEOUT,
  });

  // 设置超时处理
  room.turnTimer = setTimeout(() => {
    handleTurnTimeout(room);
  }, TURN_TIMEOUT);
}

/**
 * 停止回合倒计时
 * @param {Object} room - 房间对象
 */
function stopTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnDeadline = null;
}

/**
   * 初始化小局
   */
  function initRound(room) {
    room.status = GameStatus.PLAYING;
    room.roundStatus = RoundStatus.BETTING;
    room.currentBets.clear();
    room.currentCards.clear();
    room.playedCardsInRound.clear();
    room.firstPlayerId = null;

    // 每小局重置手牌
    for (const player of room.players.values()) {
      player.hand = generateDeck(player.deckType);
    }

    const players = Array.from(room.players.values());

    // 通知每个玩家
    for (const [socketId, player] of room.players) {
      io.to(socketId).emit('round-init', {
        round: room.currentRound,
        totalRounds: room.totalRounds,
        hand: player.hand,
        deckType: player.deckType,
        chips: player.chips,
        opponentChips: players.find(p => p.id !== socketId).chips,
        message: `第 ${room.currentRound} 局开始！请下注并出牌`,
      });
    }

    // 启动回合倒计时
    startTurnTimer(room);
  }

  /**
   * 游戏结束
   */
  function endGame(room, winnerId) {
    room.status = GameStatus.FINISHED;
    room.rematchVotes = new Set(); // 重置再来一局投票

    const players = Array.from(room.players.values());
    const player1 = players[0];
    const player2 = players[1];

    let finalResult;

    // 如果有指定赢家（筹码输光）
    if (winnerId) {
      const winner = players.find(p => p.id === winnerId);
      const loser = players.find(p => p.id !== winnerId);
      finalResult = {
        winner: winner.nickname,
        winnerId: winner.id,
        reason: 'bankrupt', // 对方破产
        player1Id: room.player1Id, // 添加player1Id，方便客户端判断
        player1Chips: player1.chips,
        player2Chips: player2.chips,
      };
    } else {
      // 比较筹码
      if (player1.chips > player2.chips) {
        finalResult = {
          winner: player1.nickname,
          winnerId: player1.id,
          reason: 'moreChips',
          player1Id: room.player1Id, // 添加player1Id，方便客户端判断
          player1Chips: player1.chips,
          player2Chips: player2.chips,
        };
      } else if (player2.chips > player1.chips) {
        finalResult = {
          winner: player2.nickname,
          winnerId: player2.id,
          reason: 'moreChips',
          player1Id: room.player1Id, // 添加player1Id，方便客户端判断
          player1Chips: player1.chips,
          player2Chips: player2.chips,
        };
      } else {
        finalResult = {
          winner: null,
          isDraw: true,
          reason: 'tie',
          player1Id: room.player1Id, // 添加player1Id，方便客户端判断
          player1Chips: player1.chips,
          player2Chips: player2.chips,
        };
      }
    }

    io.to(room.id).emit('game-end', finalResult);
    console.log(`房间 ${room.id} 游戏结束:`, finalResult);
  }

/**
   * 处理小局结果
   * @param {Object} room - 房间对象
   * @param {string} result - 比较结果
   * @param {Object} player1 - 玩家1
   * @param {Object} player2 - 玩家2
   * @param {number} bet1 - 玩家1下注
   * @param {number} bet2 - 玩家2下注
   * @param {Object} card1 - 玩家1出的牌
   * @param {Object} card2 - 玩家2出的牌
   */
  function handleRoundResult(room, result, player1, player2, bet1, bet2, card1, card2) {
    // 平局处理：不下注不扣筹码，小局继续
    if (result === 'DRAW') {
      // 平局时不下注扣除筹码，直接继续

      // 记录对局历史（平局）
      const roundRecord = {
        round: room.currentRound,
        roundAttempt: room.roundAttempt, // 当前小局内的回合数
        player1Id: room.player1Id, // 记录player1的ID（创建房间者），方便客户端判断
        player1Card: card1,
        player2Card: card2,
        player1Bet: bet1,
        player2Bet: bet2,
        winnerId: null, // 平局没有赢家
        winAmount: 0,
        isSlaveWinKing: false,
        player1Chips: player1.chips,
        player2Chips: player2.chips,
      };
      room.roundHistory.push(roundRecord);

      io.to(room.id).emit('round-draw', {
        message: '平局！筹码返还，请重新下注出牌',
        player1Id: room.player1Id, // 添加player1Id，方便客户端判断
        player1Chips: player1.chips,
        player2Chips: player2.chips,
        roundHistory: room.roundHistory,
      });

      // 清除当前小局数据，但保持小局数不变，回合数+1
      setTimeout(() => {
        room.currentBets.clear();
        room.currentCards.clear();
        room.firstPlayerId = null;
        room.roundStatus = RoundStatus.BETTING;
        room.roundAttempt++; // 平局时回合数+1

        // 平局时：从手牌中移除已出的牌，不重新发牌
        for (const [socketId, player] of room.players) {
          const playedCard = room.playedCardsInRound.get(socketId);
          if (playedCard) {
            const cardIndex = player.hand.findIndex(c => c.type === playedCard.type);
            if (cardIndex !== -1) {
              player.hand.splice(cardIndex, 1);
            }
          }
        }
        room.playedCardsInRound.clear();

        // 通知重新下注
        for (const [socketId, player] of room.players) {
          io.to(socketId).emit('round-restart', {
            hand: player.hand,
            chips: player.chips,
            opponentChips: room.players.get(getOpponentId(room, socketId)).chips,
          });
        }

        // 重新启动倒计时
        startTurnTimer(room);
      }, 2000);
      return;
    }

    // 有胜负：赢得对方下注的筹码
    let winner, loser, winBet, loseBet, winnerCard, loserCard;
    if (result === 'PLAYER1_WIN') {
      winner = player1;
      loser = player2;
      winBet = bet1;
      loseBet = bet2;
      winnerCard = card1;
      loserCard = card2;
    } else {
      winner = player2;
      loser = player1;
      winBet = bet2;
      loseBet = bet1;
      winnerCard = card2;
      loserCard = card1;
    }

    // 计算赢得的筹码
    // 奴隶赢国王时，赢得的筹码×5
    let winAmount;
    let isSlaveWinKing = winnerCard.type === 'SLAVE' && loserCard.type === 'KING';
    if (isSlaveWinKing) {
      winAmount = loseBet * 5;
    } else {
      winAmount = loseBet;
    }

    // 赢家获得：赢得的筹码（不下注扣除自己的下注，因为下注时没扣）
    winner.chips += winAmount;

    // 输家：扣除自己的下注
    loser.chips -= loseBet;

    // 奴隶赢国王时，输家额外扣除 4×loseBet（总共扣 5×loseBet）
    if (isSlaveWinKing) {
      loser.chips -= loseBet * 4;
    }

    // 记录对局历史
    const roundRecord = {
      round: room.currentRound,
      roundAttempt: room.roundAttempt, // 当前小局内的回合数
      player1Id: room.player1Id, // 记录player1的ID（创建房间者），方便客户端判断
      player1Card: card1,
      player2Card: card2,
      player1Bet: bet1,
      player2Bet: bet2,
      winnerId: winner.id,
      winAmount: winAmount,
      isSlaveWinKing: isSlaveWinKing,
      player1Chips: player1.chips,
      player2Chips: player2.chips,
    };
    room.roundHistory.push(roundRecord);

    io.to(room.id).emit('round-result', {
      result: result,
      winner: winner.nickname,
      winnerId: winner.id,
      winAmount: winAmount,
      isSlaveWinKing: isSlaveWinKing,
      player1Id: room.player1Id, // 添加player1Id，方便客户端判断
      player1Chips: player1.chips,
      player2Chips: player2.chips,
      roundHistory: room.roundHistory,
    });

    console.log(
      `房间 ${room.id} 第 ${room.currentRound}-${room.roundAttempt} 局: ${winner.nickname} 赢得 ${winAmount} 筹码${isSlaveWinKing ? ' (奴隶赢国王×5)' : ''}`,
    );

    // 检查是否有玩家输光筹码
    if (loser.chips <= 0) {
      setTimeout(() => {
        endGame(room, winner.id);
      }, 2000);
      return;
    }

    // 检查是否达到总局数
    if (room.currentRound >= room.totalRounds) {
      setTimeout(() => {
        endGame(room, null);
      }, 2000);
      return;
    }

    // 进入下一小局
    setTimeout(() => {
      room.currentRound++;
      room.roundAttempt = 1; // 新小局重置回合数

      // 检查是否需要交换阵营（每3局）
      const shouldSwap = (room.currentRound - 1) % 3 === 0;
      if (shouldSwap) {
        for (const player of room.players.values()) {
          player.deckType = player.deckType === 'KING' ? 'SLAVE' : 'KING';
        }
      }

      initRound(room);
    }, 2000);
  }

/**
 * 处理开牌
 */
function handleRoundReveal(room) {
  room.roundStatus = RoundStatus.REVEALING;

  // 使用固定的player1和player2（创建房间者和加入者）
  const player1 = room.players.get(room.player1Id);
  const player2 = room.players.get(room.player2Id);

  const card1 = room.currentCards.get(player1.id).card;
  const card2 = room.currentCards.get(player2.id).card;
  const bet1 = room.currentBets.get(player1.id);
  const bet2 = room.currentBets.get(player2.id);

  // 比较卡牌
  const result = compareCards(card1, card2);

  // 广播开牌结果
  io.to(room.id).emit('round-reveal', {
    player1Id: room.player1Id, // 添加player1Id，方便客户端判断
    player1Card: card1,
    player2Card: card2,
    player1Bet: bet1,
    player2Bet: bet2,
    result: result,
  });

  // 处理胜负
  setTimeout(() => {
    handleRoundResult(room, result, player1, player2, bet1, bet2, card1, card2);
  }, 2000);
}

/**
 * 自动下注并出牌（超时使用）
 * @param {Object} room - 房间对象
 * @param {string} playerId - 玩家ID
 * @param {number} betAmount - 下注金额
 * @param {number} cardIndex - 卡牌索引
 */
function autoBetAndPlay(room, playerId, betAmount, cardIndex) {
  const player = room.players.get(playerId);
  if (!player || player.hand.length === 0) return;

  // 如果筹码不足，使用全部剩余筹码
  if (betAmount > player.chips) {
    betAmount = player.chips;
  }
  if (betAmount <= 0) betAmount = 1;

  const playedCard = player.hand[cardIndex];
  if (!playedCard) return;

  // 记录下注和出牌（不下注扣除筹码，开牌后再处理）
  room.currentBets.set(playerId, betAmount);
  room.currentCards.set(playerId, {
    card: playedCard,
    playerId: playerId,
  });
  room.playedCardsInRound.set(playerId, playedCard);

  // 记录第一个出牌的玩家
  if (room.currentBets.size === 1) {
    room.firstPlayerId = playerId;
  }

  console.log(`房间 ${room.id}: ${player.nickname} 自动下注 ${betAmount}, 出了 ${playedCard.name}`);

  // 通知该玩家自动出牌
  io.to(playerId).emit('auto-bet-played', {
    betAmount: betAmount,
    remainingChips: player.chips,
    card: playedCard,
    cardIndex: cardIndex,
    isFirstPlayer: room.currentBets.size === 1,
  });

  // 通知对手
  const opponentId = getOpponentId(room, playerId);
  if (opponentId) {
    io.to(opponentId).emit('opponent-bet-played', {
      betAmount: betAmount,
      opponentChips: player.chips,
    });
  }

  // 检查是否双方都下注出牌了
  if (room.currentBets.size === 2) {
    stopTurnTimer(room);
    handleRoundReveal(room);
  }
}

/**
 * 处理回合超时 - 为未出牌的玩家随机出牌
 * @param {Object} room - 房间对象
 */
function handleTurnTimeout(room) {
  if (room.status !== GameStatus.PLAYING || room.roundStatus !== RoundStatus.BETTING) {
    return;
  }

  // 为每个未出牌的玩家随机出牌
  for (const [playerId, player] of room.players) {
    if (!room.currentBets.has(playerId)) {
      // 随机选择一张牌
      const randomCardIndex = Math.floor(Math.random() * player.hand.length);
      // 下注金额为总筹码的1/3取整（至少为1）
      const autoBet = Math.max(1, Math.floor(player.chips / 3));

      console.log(`房间 ${room.id}: 玩家 ${player.nickname} 超时，自动出牌`);

      // 执行自动下注出牌
      autoBetAndPlay(room, playerId, autoBet, randomCardIndex);
    }
  }
}

/**
 * 创建新房间
 * @param {string} socketId - 创建者socket ID
 * @param {string} nickname - 玩家昵称
 * @returns {Object} 房间信息
 */
function createRoom(socketId, nickname) {
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    status: GameStatus.WAITING,
    players: new Map(),
    player1Id: socketId, // 记录玩家1的ID（创建房间者）
    player2Id: null, // 玩家2的ID（加入者）
    currentRound: 1, // 当前小局数（1-12）
    roundAttempt: 1, // 当前小局内的回合数（平局时增加）
    totalRounds: 12,
    roundStatus: RoundStatus.BETTING,
    currentBets: new Map(), // 当前小局的下注
    currentCards: new Map(), // 当前小局出的牌
    playedCardsInRound: new Map(), // 当前小局中已出的牌（用于平局时移除）
    firstPlayerId: null, // 先出牌的玩家
    roundHistory: [], // 对局历史记录
    turnTimer: null, // 回合倒计时定时器
    turnDeadline: null, // 回合截止时间
    createdAt: Date.now(),
  };

  room.players.set(socketId, {
    id: socketId,
    nickname: nickname,
    deckType: 'KING',
    hand: [],
    chips: INITIAL_CHIPS, // 初始筹码
    isReady: false,
  });

  rooms.set(roomId, room);
  return room;
}

// Socket.IO 连接处理
io.on('connection', socket => {
  console.log('玩家连接:', socket.id);

  /**
   * 创建房间
   */
  socket.on('create-room', nickname => {
    const room = createRoom(socket.id, nickname);
    socket.join(room.id);
    socket.emit('room-created', {
      roomId: room.id,
      playerId: socket.id,
      nickname: nickname,
    });
    console.log(`房间 ${room.id} 已创建, 玩家: ${nickname}`);
  });

  /**
   * 加入房间
   */
  socket.on('join-room', data => {
    const { roomId, nickname } = data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('error', { message: '房间不存在' });
      return;
    }

    if (room.players.size >= 2) {
      socket.emit('error', { message: '房间已满' });
      return;
    }

    // 添加第二个玩家
    room.players.set(socket.id, {
      id: socket.id,
      nickname: nickname,
      deckType: 'SLAVE',
      hand: [],
      chips: INITIAL_CHIPS,
      isReady: true,
    });
    room.player2Id = socket.id; // 记录玩家2的ID

    socket.join(roomId);

    const player1 = room.players.get(room.player1Id);
    const player2 = room.players.get(room.player2Id);

    // 通知双方游戏开始
    io.to(roomId).emit('game-start', {
      roomId: roomId,
      player1: {
        id: player1.id,
        nickname: player1.nickname,
        deckType: player1.deckType,
        chips: player1.chips,
      },
      player2: {
        id: player2.id,
        nickname: player2.nickname,
        deckType: player2.deckType,
        chips: player2.chips,
      },
    });

    // 初始化游戏
    initRound(room);

    console.log(`玩家 ${nickname} 加入房间 ${roomId}`);
  });

  

  

  /**
   * 玩家下注并出牌
   */
  socket.on('bet-and-play', data => {
    const { roomId, betAmount, cardIndex } = data;
    const room = rooms.get(roomId);

    if (!room || room.status !== GameStatus.PLAYING) return;

    const player = room.players.get(socket.id);
    if (!player || player.hand.length === 0) return;

    // 验证下注金额
    if (betAmount <= 0 || betAmount > player.chips) {
      socket.emit('error', { message: '下注金额无效' });
      return;
    }

    // 检查是否已经下注出牌过
    if (room.currentBets.has(socket.id)) return;

    // 获取出的牌
    const playedCard = player.hand[cardIndex];
    if (!playedCard) return;

    // 记录下注和出牌（不下注扣除筹码，开牌后再处理）
    room.currentBets.set(socket.id, betAmount);
    room.currentCards.set(socket.id, {
      card: playedCard,
      playerId: socket.id,
    });
    // 记录本小局已出的牌（平局时使用）
    room.playedCardsInRound.set(socket.id, playedCard);

    // 记录第一个出牌的玩家
    if (room.currentBets.size === 1) {
      room.firstPlayerId = socket.id;
    }

    console.log(`房间 ${roomId}: ${player.nickname} 下注 ${betAmount}, 出了 ${playedCard.name}`);

    // 通知自己（返回当前筹码，不下注扣除）
    socket.emit('bet-played', {
      betAmount: betAmount,
      remainingChips: player.chips,
      isFirstPlayer: room.currentBets.size === 1,
    });

    // 通知对手（显示卡背和下注金额，不下注扣除筹码）
    socket.to(roomId).emit('opponent-bet-played', {
      betAmount: betAmount,
      opponentChips: player.chips,
    });

    // 检查是否双方都下注出牌了
    if (room.currentBets.size === 2) {
      stopTurnTimer(room);
      handleRoundReveal(room);
    }
  });

  /**
   * 获取对手ID
   */
  function getOpponentId(room, playerId) {
    for (const id of room.players.keys()) {
      if (id !== playerId) return id;
    }
    return null;
  }

  

  /**
   * 玩家投票再来一局
   */
  socket.on('rematch-vote', roomId => {
    const room = rooms.get(roomId);
    if (!room || room.status !== GameStatus.FINISHED) return;

    // 记录投票
    room.rematchVotes.add(socket.id);
    const player = room.players.get(socket.id);

    console.log(`房间 ${roomId}: ${player.nickname} 投票再来一局 (${room.rematchVotes.size}/2)`);

    // 通知所有人有人投票了
    io.to(roomId).emit('rematch-status', {
      votedCount: room.rematchVotes.size,
      totalPlayers: room.players.size,
      voterName: player.nickname,
    });

    // 如果双方都投票了，重新开始游戏
    if (room.rematchVotes.size >= 2) {
      console.log(`房间 ${roomId}: 双方同意，重新开始游戏`);
      resetGame(room);
    }
  });

  /**
   * 重置游戏
   */
  function resetGame(room) {
    // 重置玩家状态
    for (const player of room.players.values()) {
      player.chips = INITIAL_CHIPS;
      player.hand = [];
    }

    // 重置房间状态
    room.currentRound = 1;
    room.roundAttempt = 1; // 重置回合数
    room.status = GameStatus.PLAYING;
    room.roundStatus = RoundStatus.BETTING;
    room.currentBets.clear();
    room.currentCards.clear();
    room.playedCardsInRound.clear();
    room.firstPlayerId = null;
    room.rematchVotes.clear();
    room.roundHistory = []; // 清空对局历史

    const players = Array.from(room.players.values());

    // 通知双方游戏重新开始
    io.to(room.id).emit('game-restart', {
      message: '游戏重新开始！',
      player1: {
        id: players[0].id,
        nickname: players[0].nickname,
        deckType: players[0].deckType,
        chips: players[0].chips,
      },
      player2: {
        id: players[1].id,
        nickname: players[1].nickname,
        deckType: players[1].deckType,
        chips: players[1].chips,
      },
    });

    // 初始化第一局
    initRound(room);
  }

  /**
   * 玩家断开连接
   */
  socket.on('disconnect', () => {
    console.log('玩家断开连接:', socket.id);

    for (const [roomId, room] of rooms) {
      if (room.players.has(socket.id)) {
        const player = room.players.get(socket.id);
        socket.to(roomId).emit('opponent-left', {
          message: `${player.nickname} 离开了游戏`,
        });
        rooms.delete(roomId);
        console.log(`房间 ${roomId} 已删除`);
        break;
      }
    }
  });

  /**
   * 主动离开房间
   */
  socket.on('leave-room', roomId => {
    const room = rooms.get(roomId);
    if (room && room.players.has(socket.id)) {
      const player = room.players.get(socket.id);
      socket.to(roomId).emit('opponent-left', {
        message: `${player.nickname} 离开了游戏`,
      });
      rooms.delete(roomId);
    }
    socket.leave(roomId);
  });
});

// 启动服务器
const DEFAULT_PORT = 3000;

/**
 * 尝试启动服务器，如果端口被占用则自动尝试下一个端口
 * @param {number} port - 要尝试的端口号
 */
function startServer(port) {
  server.listen(port, () => {
    console.log(`E-Card 筹码制服务器运行在端口 ${port}`);
    console.log(`访问 http://localhost:${port} 开始游戏`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 已被占用，尝试端口 ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('服务器启动失败:', err);
      process.exit(1);
    }
  });
}

// 启动服务器
startServer(process.env.PORT || DEFAULT_PORT);
