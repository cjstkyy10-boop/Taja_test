const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const HangulUtil = require('./public/hangul.js');
const DEFAULT_PRESETS = require('./public/presets.js');

const app = express();
const server = http.createServer(app);

// 다수 학생(30명 이상) 동시 접속을 위한 HTTP 서버 튜닝
server.maxConnections = 500;
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
  httpCompression: true
});

const PORT = process.env.PORT || 3000;

// 정적 파일 캐싱 적용으로 터널/네트워크 연결 슬롯 절약
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true
}));
app.use(express.json());

// 로컬 네트워크 IP 가져오기
function getLocalIPAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// 방 데이터 저장소
// roomId (PIN 6자리) -> Room Object
const rooms = new Map();
let publicTunnelUrl = null;

function generatePin() {
  let pin;
  do {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(pin));
  return pin;
}

// 귀여운 동물 아바타 목록 (학생들에게 랜덤 부여)
const AVATARS = ['🦁', '🐯', '🐰', '🐼', '🦊', '🐻', '🐨', '🐵', '🦄', '🐬', '🐥', '🐶', '🐱', '🐹', '🐧', '🦉'];

io.on('connection', (socket) => {
  let currentRoomPin = null;
  let isTeacher = false;
  let studentData = null;

  // 1. [선생님] 방 생성 (재연결 시 기존 방 및 학생 목록 유지 지원)
  socket.on('teacher:create_room', (data, callback) => {
    const requestedPin = data?.pin;
    let room;

    if (requestedPin && rooms.has(requestedPin)) {
      // 기존 방 복구 (선생님 소켓 재연결 시)
      room = rooms.get(requestedPin);
      room.teacherSocketId = socket.id;
      currentRoomPin = requestedPin;
      isTeacher = true;
      socket.join(requestedPin);
      console.log(`[선생님] 기존 타자 경시대회 방 재연결: PIN ${requestedPin} (현재 학생 ${room.students.size}명)`);
    } else {
      const pin = requestedPin || generatePin();
      currentRoomPin = pin;
      isTeacher = true;

      const initialPassage = data?.passage || DEFAULT_PRESETS[0];
      const totalStrokes = HangulUtil.getTotalStrokes(initialPassage.content);

      room = {
        pin,
        teacherSocketId: socket.id,
        status: 'waiting', // waiting, countdown, in_progress, finished
        passage: {
          ...initialPassage,
          totalStrokes
        },
        startTime: null,
        endTime: null,
        students: new Map(), // socketId -> studentObj
        countdownSeconds: 3
      };

      rooms.set(pin, room);
      socket.join(pin);

      console.log(`[선생님] 새 타자 경시대회 방 생성: PIN ${pin}`);
    }

    if (callback) {
      callback({
        success: true,
        pin: room.pin,
        passage: room.passage,
        status: room.status,
        students: getStudentList(room),
        localIps: getLocalIPAddresses(),
        port: PORT,
        publicUrl: publicTunnelUrl
      });
    }
  });

  // 2. [선생님] 지문 변경
  socket.on('teacher:update_passage', (passageData, callback) => {
    if (!currentRoomPin || !rooms.has(currentRoomPin)) return;
    const room = rooms.get(currentRoomPin);
    if (room.teacherSocketId !== socket.id) return;
    if (room.status === 'in_progress') {
      if (callback) callback({ success: false, message: '시험 진행 중에는 지문을 변경할 수 없습니다.' });
      return;
    }

    const totalStrokes = HangulUtil.getTotalStrokes(passageData.content);
    room.passage = {
      ...passageData,
      totalStrokes
    };

    io.to(currentRoomPin).emit('room:passage_updated', room.passage);
    if (callback) callback({ success: true, passage: room.passage });
  });

  // 3. [선생님] 시험 카운트다운 시작
  socket.on('teacher:start_countdown', (countdownSec = 3) => {
    if (!currentRoomPin || !rooms.has(currentRoomPin)) return;
    const room = rooms.get(currentRoomPin);
    if (room.teacherSocketId !== socket.id) return;
    if (room.status === 'in_progress') return;

    room.status = 'countdown';
    room.countdownSeconds = countdownSec;

    // 모든 학생들의 실시간 상태 리셋
    for (const [sId, s] of room.students.entries()) {
      s.inputText = '';
      s.progress = 0;
      s.cpm = 0;
      s.accuracy = 100;
      s.typoCount = 0;
      s.validStrokes = 0;
      s.isCompleted = false;
      s.finishTime = null;
      s.rank = null;
    }

    io.to(currentRoomPin).emit('room:countdown_started', { countdownSec });

    let count = countdownSec;
    const timer = setInterval(() => {
      count--;
      if (count > 0) {
        io.to(currentRoomPin).emit('room:countdown_tick', { count });
      } else {
        clearInterval(timer);
        // 카운트다운 끝나고 바로 시작!
        room.status = 'in_progress';
        room.startTime = Date.now();
        io.to(currentRoomPin).emit('room:test_started', {
          startTime: room.startTime,
          timeLimit: room.passage.timeLimit || 0
        });
        console.log(`[방 ${currentRoomPin}] 시험 시작됨! 참가 학생 수: ${room.students.size}명`);
      }
    }, 1000);
  });

  // 4. [선생님] 시험 강제 종료 또는 시간 종료
  socket.on('teacher:finish_test', () => {
    if (!currentRoomPin || !rooms.has(currentRoomPin)) return;
    const room = rooms.get(currentRoomPin);
    if (room.teacherSocketId !== socket.id) return;

    finishRoomTest(room);
  });

  // 5. [선생님] 다시 시험 준비 (재도전/다음 시험)
  socket.on('teacher:reset_room', () => {
    if (!currentRoomPin || !rooms.has(currentRoomPin)) return;
    const room = rooms.get(currentRoomPin);
    if (room.teacherSocketId !== socket.id) return;

    room.status = 'waiting';
    room.startTime = null;
    room.endTime = null;

    for (const [sId, s] of room.students.entries()) {
      s.inputText = '';
      s.progress = 0;
      s.cpm = 0;
      s.accuracy = 100;
      s.typoCount = 0;
      s.validStrokes = 0;
      s.isCompleted = false;
      s.finishTime = null;
      s.rank = null;
    }

    io.to(currentRoomPin).emit('room:reset', {
      passage: room.passage,
      students: getStudentList(room)
    });
  });

  // 6. [선생님] 특정 학생 내보내기
  socket.on('teacher:kick_student', (targetSocketId) => {
    if (!currentRoomPin || !rooms.has(currentRoomPin)) return;
    const room = rooms.get(currentRoomPin);
    if (room.teacherSocketId !== socket.id) return;

    if (room.students.has(targetSocketId)) {
      const student = room.students.get(targetSocketId);
      room.students.delete(targetSocketId);
      io.to(targetSocketId).emit('student:kicked');
      io.to(room.teacherSocketId).emit('room:student_list', getStudentList(room));
      console.log(`[방 ${currentRoomPin}] 학생 ${student.name} 퇴장 처리됨`);
    }
  });

  // 7. [학생] 방 참가
  socket.on('student:join', ({ pin, name, seatNumber }, callback) => {
    const cleanPin = (pin || '').trim();
    const cleanName = (name || '').trim();
    const cleanSeat = (seatNumber || '').trim();

    if (!cleanPin || !rooms.has(cleanPin)) {
      if (callback) callback({ success: false, message: '유효하지 않은 방 번호(PIN)입니다. 다시 확인해 주세요.' });
      return;
    }

    const room = rooms.get(cleanPin);

    if (!cleanName) {
      if (callback) callback({ success: false, message: '이름을 입력해 주세요.' });
      return;
    }

    // 이미 같은 이름과 번호로 접속 중인지 체크 (선택사항, 재접속 허용 고려)
    let existingAvatar = null;
    for (const [sId, s] of room.students.entries()) {
      if (s.name === cleanName && s.seatNumber === cleanSeat) {
        existingAvatar = s.avatar;
        room.students.delete(sId);
        break;
      }
    }

    const avatar = existingAvatar || AVATARS[Math.floor(Math.random() * AVATARS.length)];

    currentRoomPin = cleanPin;
    isTeacher = false;
    studentData = {
      socketId: socket.id,
      name: cleanName,
      seatNumber: cleanSeat || '-',
      avatar,
      progress: 0,
      cpm: 0,
      accuracy: 100,
      typoCount: 0,
      validStrokes: 0,
      isCompleted: false,
      finishTime: null,
      elapsedSeconds: 0,
      rank: null
    };

    room.students.set(socket.id, studentData);
    socket.join(cleanPin);

    console.log(`[방 ${cleanPin}] 학생 입장: ${cleanSeat}번 ${cleanName} (${avatar}) - 현재 총 ${room.students.size}명`);

    // 선생님 및 방의 모든 참가자에게 학생 목록 갱신 통보
    io.to(room.teacherSocketId).emit('room:student_list', getStudentList(room));

    if (callback) {
      callback({
        success: true,
        passage: room.passage,
        status: room.status,
        student: studentData,
        startTime: room.startTime
      });
    }
  });

  // 8. [학생] 실시간 타이핑 진행 보고
  socket.on('student:typing_progress', (data) => {
    if (!currentRoomPin || !rooms.has(currentRoomPin) || !studentData) return;
    const room = rooms.get(currentRoomPin);
    if (room.status !== 'in_progress') return;

    const student = room.students.get(socket.id);
    if (!student || student.isCompleted) return;

    student.progress = data.progress || 0;
    student.cpm = data.cpm || 0;
    student.accuracy = data.accuracy !== undefined ? data.accuracy : 100;
    student.typoCount = data.typoCount || 0;
    student.validStrokes = data.validStrokes || 0;
    student.elapsedSeconds = data.elapsedSeconds || 0;

    // 선생님 화면으로 학생의 진행 상황 실시간 업데이트
    io.to(room.teacherSocketId).emit('room:student_progress', {
      socketId: socket.id,
      name: student.name,
      seatNumber: student.seatNumber,
      avatar: student.avatar,
      progress: student.progress,
      cpm: student.cpm,
      accuracy: student.accuracy,
      typoCount: student.typoCount,
      validStrokes: student.validStrokes,
      elapsedSeconds: student.elapsedSeconds,
      isCompleted: student.isCompleted
    });
  });

  // 9. [학생] 완주 제출 (문장 끝까지 입력 완료)
  socket.on('student:submit_test', (data, callback) => {
    if (!currentRoomPin || !rooms.has(currentRoomPin) || !studentData) return;
    const room = rooms.get(currentRoomPin);
    const student = room.students.get(socket.id);
    if (!student) return;

    student.progress = 100;
    student.cpm = data.cpm || 0;
    student.accuracy = data.accuracy !== undefined ? data.accuracy : 100;
    student.typoCount = data.typoCount || 0;
    student.validStrokes = data.validStrokes || 0;
    student.elapsedSeconds = data.elapsedSeconds || 0;
    student.isCompleted = true;
    student.finishTime = Date.now();

    // 완주 순위 계산 (완료한 학생들 중 순서)
    const completedCount = Array.from(room.students.values()).filter(s => s.isCompleted).length;
    student.rank = completedCount;

    console.log(`[방 ${currentRoomPin}] 학생 완주! ${student.seatNumber}번 ${student.name} - ${student.cpm}타/분, 정확도 ${student.accuracy}%, 오타 ${student.typoCount}개 (완주순위 ${student.rank}위)`);

    // 학생에게 본인 최종 결과 전송
    if (callback) {
      callback({
        success: true,
        rank: student.rank,
        student
      });
    }

    // 선생님에게 업데이트
    io.to(room.teacherSocketId).emit('room:student_completed', student);
    io.to(room.teacherSocketId).emit('room:student_list', getStudentList(room));

    // 혹시 모든 접속 학생이 완주했는지 체크
    const allStudents = Array.from(room.students.values());
    if (allStudents.length > 0 && allStudents.every(s => s.isCompleted)) {
      console.log(`[방 ${currentRoomPin}] 모든 학생 시험 완료! 자동 종료 처리.`);
      finishRoomTest(room);
    }
  });

  // 10. 접속 해제 처리
  socket.on('disconnect', () => {
    if (isTeacher && currentRoomPin && rooms.has(currentRoomPin)) {
      console.log(`[방 ${currentRoomPin}] 선생님 접속 종료`);
      // 선생님이 나가도 5분간 방을 유지하거나 안내 브로드캐스트
      io.to(currentRoomPin).emit('room:teacher_disconnected');
    } else if (currentRoomPin && rooms.has(currentRoomPin)) {
      const room = rooms.get(currentRoomPin);
      if (room.students.has(socket.id)) {
        const student = room.students.get(socket.id);
        room.students.delete(socket.id);
        console.log(`[방 ${currentRoomPin}] 학생 퇴장: ${student.name} (남은 학생: ${room.students.size}명)`);
        io.to(room.teacherSocketId).emit('room:student_list', getStudentList(room));
      }
    }
  });
});

// 시험 종료 및 최종 종합 성적표 산출
function finishRoomTest(room) {
  room.status = 'finished';
  room.endTime = Date.now();

  // 최종 성적 정렬:
  // 1순위: 타수(CPM) 높은 순
  // 2순위: 정확도 높은 순
  // 3순위: 오타 적은 순
  const rankedList = Array.from(room.students.values()).sort((a, b) => {
    if (b.cpm !== a.cpm) return b.cpm - a.cpm;
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return a.typoCount - b.typoCount;
  });

  // 최종 등수 부여
  rankedList.forEach((s, idx) => {
    s.finalRank = idx + 1;
    // 개별 학생에게도 전달할 수 있도록 원본 맵 갱신
    if (room.students.has(s.socketId)) {
      room.students.get(s.socketId).finalRank = idx + 1;
    }
  });

  io.to(room.pin).emit('room:test_finished', {
    rankings: rankedList,
    totalStudents: rankedList.length,
    endTime: room.endTime
  });

  console.log(`[방 ${room.pin}] 시험 종료 및 최종 순위 산출 완료! 참가자 수: ${rankedList.length}`);
}

function getStudentList(room) {
  return Array.from(room.students.values()).map(s => ({
    socketId: s.socketId,
    name: s.name,
    seatNumber: s.seatNumber,
    avatar: s.avatar,
    progress: s.progress,
    cpm: s.cpm,
    accuracy: s.accuracy,
    typoCount: s.typoCount,
    validStrokes: s.validStrokes,
    isCompleted: s.isCompleted,
    rank: s.rank,
    finalRank: s.finalRank
  }));
}

// IP 정보 API (선생님 화면에서 표시할 수 있도록)
app.get('/api/server-info', (req, res) => {
  res.json({
    localIps: getLocalIPAddresses(),
    port: PORT,
    publicUrl: publicTunnelUrl,
    presets: DEFAULT_PRESETS
  });
});

// 기본 경로('/')는 학생 페이지로 리다이렉트 또는 서빙
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 선생님 전용 관리자 페이지 경로
app.get('/teacher', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

// 외부 인터넷 주소 자동 생성 (학교 방화벽 443 포트 100% 통과 클라우드 배포 + Cloudflare 터널)
function startPublicTunnel() {
  console.log('\n⏳ [인터넷 연결] 학교 방화벽 우회용 전교생 접속 주소를 생성하는 중입니다 (약 4~7초 소요)...');

  let tunnelResolved = false;
  const fs = require('fs');
  const { spawn, exec } = require('child_process');

  const onTunnelReady = (url, typeName) => {
    if (tunnelResolved) return;
    tunnelResolved = true;
    publicTunnelUrl = url;
    console.log('\n========================================================');
    console.log(`🎉 [${typeName}] 학생 30명 동시 접속 주소가 준비되었습니다!`);
    console.log(`👉 학생 접속 주소: ${url}`);
    console.log('   (선생님 브라우저 화면에도 자동으로 표시되었습니다!)');
    console.log('========================================================\n');
    io.emit('server:tunnel_url', { publicUrl: url });
  };

  // dist 폴더 최신화
  try {
    const srcDir = path.join(__dirname, 'public');
    const destDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
    }
  } catch (e) {}

  // 1순위: 표준 HTTPS(443 포트) 클라우드 정적 배포 (503 에러 없음, 학교 방화벽 100% 통과)
  try {
    const shipProc = exec('npx --yes @shipstatic/ship ./dist', { cwd: __dirname });
    const handleShip = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.shipstatic\.com/);
      if (match) {
        onTunnelReady(match[0], '학교 방화벽 무관 클라우드 주소');
      }
    };
    if (shipProc.stdout) shipProc.stdout.on('data', handleShip);
    if (shipProc.stderr) shipProc.stderr.on('data', handleShip);
  } catch (e) {}

  // 2순위: Cloudflare 고속 터널
  try {
    const cfBin = path.join(__dirname, 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe');
    if (fs.existsSync(cfBin)) {
      const cfProc = spawn(cfBin, ['tunnel', '--url', `http://localhost:${PORT}`, '--protocol', 'http2']);
      const handleOutput = (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !match[0].includes('api.trycloudflare.com')) {
          onTunnelReady(match[0], '무제한 고속 터널');
        }
      };
      cfProc.stdout.on('data', handleOutput);
      cfProc.stderr.on('data', handleOutput);
      cfProc.on('error', () => {});
    }
  } catch (e) {}
}

// 예기치 않은 네트워크/터널 에러로 서버가 종료되지 않도록 보호
process.on('uncaughtException', (err) => {
  console.warn('[시스템 보호] 네트워크 예외 무시됨:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[시스템 보호] 비동기 예외 무시됨:', reason);
});

// 이미 3000번 포트에 서버가 켜져 있을 경우 바로 브라우저 열기
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('이미 서버가 실행 중입니다! 선생님 화면을 엽니다...');
    const { exec } = require('child_process');
    exec(`start "" "http://localhost:${PORT}/teacher"`);
    setTimeout(() => process.exit(0), 1500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPAddresses();
  console.log('========================================================');
  console.log('🌟 [한글 타자 경시대회] 실시간 웹앱 서버가 시작되었습니다! 🌟');
  console.log(`- 선생님 관리 화면: http://localhost:${PORT}/teacher`);
  console.log('- 같은 공유기/유선랜 접속 주소:');
  ips.forEach(ip => {
    console.log(`  👉 http://${ip}:${PORT}`);
  });
  console.log('========================================================');

  // 서버가 100% 켜진 직후 자동으로 선생님 브라우저 화면 열기
  try {
    const { exec } = require('child_process');
    exec(`start "" "http://localhost:${PORT}/teacher"`);
  } catch (e) {}

  // 자동으로 인터넷 터널 주소도 함께 생성
  startPublicTunnel();
});
