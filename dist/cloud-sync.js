/**
 * 학교 방화벽(스쿨넷) / AP 격리 / 공유기 차단을 100% 우회하는
 * 멀티 브로커 클라우드 실시간 브릿지 (표준 HTTPS/WSS 443 포트 + 순수 HTTPS SSE 백업)
 */
(function(window) {
  const AVATARS = ['🦁', '🐯', '🐰', '🐼', '🦊', '🐻', '🐨', '🐵', '🦄', '🐬', '🐥', '🐶', '🐱', '🐹', '🐧', '🦉'];
  const BROKERS = [
    'wss://mqtt.eclipseprojects.io:443/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  window.initCloudBridge = function(localSocket) {
    const clientId = 'hc_' + Math.random().toString(36).substring(2, 10);
    const listeners = new Map();
    const clients = [];
    const seenMsgIds = new Set();
    let isCloudConnected = false;
    let ntfyEventSource = null;
    let ntfySubscribedPin = null;

    let currentPin = null;
    let role = null; // 'teacher' | 'student'
    let roomState = {
      pin: null,
      status: 'waiting',
      passage: null,
      startTime: null,
      students: new Map()
    };
    let myStudentInfo = null;

    function triggerLocalEvent(event, data) {
      const cbs = listeners.get(event) || [];
      cbs.forEach(cb => {
        try { cb(data); } catch (e) { console.error(e); }
      });
    }

    function genMsgId() {
      return clientId + '_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    }

    function markSeen(msgId) {
      if (!msgId) return false;
      if (seenMsgIds.has(msgId)) return true;
      seenMsgIds.add(msgId);
      if (seenMsgIds.size > 3000) {
        const first = seenMsgIds.values().next().value;
        seenMsgIds.delete(first);
      }
      return false;
    }

    // 1) 다중 WSS MQTT 브로커 동시 연결
    if (typeof mqtt !== 'undefined') {
      BROKERS.forEach((brokerUrl) => {
        try {
          const c = mqtt.connect(brokerUrl, {
            clientId: clientId + '_' + Math.random().toString(36).substring(2, 5),
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 3000
          });

          c.on('connect', () => {
            console.log('☁️ 클라우드 브릿지 연결 성공:', brokerUrl);
            if (!isCloudConnected) {
              isCloudConnected = true;
              triggerLocalEvent('connect');
            }
            if (currentPin && role === 'teacher') {
              c.subscribe(`hc2026/${currentPin}/to_teacher`, { qos: 0 });
              publishRoomState();
            } else if (currentPin && role === 'student' && myStudentInfo) {
              c.subscribe(`hc2026/${currentPin}/to_students`, { qos: 0 });
              c.subscribe(`hc2026/${currentPin}/state`, { qos: 0 });
              publishToTeacher(currentPin, 'student:join', myStudentInfo);
            }
          });

          c.on('message', (topic, message) => {
            try {
              const data = JSON.parse(message.toString());
              if (data && markSeen(data._msgId)) return;
              handleCloudMessage(topic, data);
            } catch (e) {}
          });

          c.on('error', () => {});
          clients.push(c);
        } catch (e) {}
      });
    }

    // 2) 순수 HTTPS 443 SSE 백업 채널 (모든 웹소켓이 차단된 극단적 학교 방화벽 대비)
    function ensureHttpsChannel(pin) {
      if (!pin || ntfySubscribedPin === pin) return;
      ntfySubscribedPin = pin;
      if (ntfyEventSource) {
        try { ntfyEventSource.close(); } catch (e) {}
      }
      try {
        const sseUrl = `https://ntfy.sh/hc2026_kr_pin_${pin}/sse`;
        ntfyEventSource = new EventSource(sseUrl);
        ntfyEventSource.onmessage = (e) => {
          try {
            const outer = JSON.parse(e.data);
            if (!outer || outer.event !== 'message' || !outer.message) return;
            const inner = JSON.parse(outer.message);
            if (!inner || !inner._topic || !inner._data) return;
            if (markSeen(inner._data._msgId)) return;
            handleCloudMessage(inner._topic, inner._data);
          } catch (err) {}
        };
      } catch (e) {}
    }

    function subscribeAll(topic) {
      clients.forEach(c => {
        try { if (c.connected) c.subscribe(topic, { qos: 0 }); } catch (e) {}
      });
    }

    function publishAll(topic, obj, opts = { qos: 0 }, useHttpsBackup = false) {
      const msgWithId = { ...obj, _msgId: genMsgId() };
      const payload = JSON.stringify(msgWithId);
      let sentViaMqtt = false;
      clients.forEach(c => {
        try {
          if (c.connected) {
            c.publish(topic, payload, opts);
            sentViaMqtt = true;
          }
        } catch (e) {}
      });

      // 중요 이벤트이거나 MQTT 연결이 아직 안 된 경우 순수 HTTPS POST (443)로도 전송
      if (useHttpsBackup || !sentViaMqtt) {
        if (currentPin) {
          fetch(`https://ntfy.sh/hc2026_kr_pin_${currentPin}`, {
            method: 'POST',
            body: JSON.stringify({ _topic: topic, _data: msgWithId })
          }).catch(() => {});
        }
      }
    }

    function subscribeTeacherTopics(pin) {
      subscribeAll(`hc2026/${pin}/to_teacher`);
      ensureHttpsChannel(pin);
    }

    function subscribeStudentTopics(pin) {
      subscribeAll(`hc2026/${pin}/to_students`);
      subscribeAll(`hc2026/${pin}/state`);
      ensureHttpsChannel(pin);
    }

    function publishRoomState() {
      if (!currentPin) return;
      publishAll(`hc2026/${currentPin}/state`, {
        pin: currentPin,
        status: roomState.status,
        passage: roomState.passage,
        startTime: roomState.startTime
      }, { qos: 0, retain: true }, true);
    }

    function publishToStudents(pin, type, payload, targetId = null, important = true) {
      if (!pin) return;
      publishAll(`hc2026/${pin}/to_students`, {
        type,
        payload,
        targetId,
        senderId: clientId
      }, { qos: 0 }, important);
    }

    function publishToTeacher(pin, type, payload, important = false) {
      if (!pin) return;
      publishAll(`hc2026/${pin}/to_teacher`, {
        type,
        payload,
        senderId: clientId
      }, { qos: 0 }, important);
    }

    function handleCloudMessage(topic, msg) {
      if (!msg) return;

      // [선생님] 학생으로부터 메시지 수신
      if (role === 'teacher' && topic === `hc2026/${currentPin}/to_teacher`) {
        const { type, payload, senderId } = msg;

        if (type === 'student:join') {
          let existingAvatar = null;
          for (const [sId, s] of roomState.students.entries()) {
            if (s.name === payload.name && s.seatNumber === payload.seatNumber) {
              existingAvatar = s.avatar;
              roomState.students.delete(sId);
              break;
            }
          }
          const avatar = existingAvatar || AVATARS[Math.floor(Math.random() * AVATARS.length)];
          const studentData = {
            socketId: senderId,
            name: payload.name,
            seatNumber: payload.seatNumber || '-',
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
          roomState.students.set(senderId, studentData);

          publishToStudents(currentPin, 'student:join_ack', {
            success: true,
            passage: roomState.passage,
            status: roomState.status,
            student: studentData,
            startTime: roomState.startTime
          }, senderId, true);

          triggerLocalEvent('room:student_list', Array.from(roomState.students.values()));
        } else if (type === 'student:typing_progress') {
          const student = roomState.students.get(senderId);
          if (student && !student.isCompleted) {
            student.progress = payload.progress || 0;
            student.cpm = payload.cpm || 0;
            student.accuracy = payload.accuracy !== undefined ? payload.accuracy : 100;
            student.typoCount = payload.typoCount || 0;
            student.validStrokes = payload.validStrokes || 0;
            student.elapsedSeconds = payload.elapsedSeconds || 0;

            triggerLocalEvent('room:student_progress', {
              socketId: senderId,
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
          }
        } else if (type === 'student:submit_test') {
          const student = roomState.students.get(senderId);
          if (student) {
            student.progress = 100;
            student.cpm = payload.cpm || 0;
            student.accuracy = payload.accuracy !== undefined ? payload.accuracy : 100;
            student.typoCount = payload.typoCount || 0;
            student.validStrokes = payload.validStrokes || 0;
            student.elapsedSeconds = payload.elapsedSeconds || 0;
            student.isCompleted = true;
            student.finishTime = Date.now();

            const completedCount = Array.from(roomState.students.values()).filter(s => s.isCompleted).length;
            student.rank = completedCount;

            publishToStudents(currentPin, 'student:submit_ack', {
              success: true,
              rank: student.rank,
              student
            }, senderId, true);

            triggerLocalEvent('room:student_completed', student);
            triggerLocalEvent('room:student_list', Array.from(roomState.students.values()));

            const allStudents = Array.from(roomState.students.values());
            if (allStudents.length > 0 && allStudents.every(s => s.isCompleted)) {
              finishCloudTest();
            }
          }
        }
      }

      // [학생] 선생님으로부터 메시지 수신
      if (role === 'student') {
        if (topic === `hc2026/${currentPin}/state`) {
          if (msg.passage && !roomState.passage) {
            roomState.passage = msg.passage;
            triggerLocalEvent('room:passage_updated', msg.passage);
          }
        } else if (topic === `hc2026/${currentPin}/to_students`) {
          const { type, payload, targetId } = msg;
          if (targetId && targetId !== clientId) return;

          if (type === 'student:join_ack') {
            if (window._pendingJoinCallback) {
              const cb = window._pendingJoinCallback;
              window._pendingJoinCallback = null;
              cb(payload);
            }
          } else if (type === 'student:submit_ack') {
            if (window._pendingSubmitCallback) {
              const cb = window._pendingSubmitCallback;
              window._pendingSubmitCallback = null;
              cb(payload);
            }
          } else {
            triggerLocalEvent(type, payload);
          }
        }
      }
    }

    function finishCloudTest() {
      roomState.status = 'finished';
      const rankedList = Array.from(roomState.students.values()).sort((a, b) => {
        if ((b.cpm || 0) !== (a.cpm || 0)) return (b.cpm || 0) - (a.cpm || 0);
        if ((b.accuracy || 0) !== (a.accuracy || 0)) return (b.accuracy || 0) - (a.accuracy || 0);
        return (a.typoCount || 0) - (b.typoCount || 0);
      });
      rankedList.forEach((s, idx) => s.finalRank = idx + 1);

      const finishPayload = {
        rankings: rankedList,
        totalStudents: rankedList.length,
        endTime: Date.now()
      };
      publishToStudents(currentPin, 'room:test_finished', finishPayload, null, true);
      triggerLocalEvent('room:test_finished', finishPayload);
    }

    const hybridSocket = {
      id: localSocket?.id || clientId,
      on: function(event, callback) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(callback);
        if (localSocket) {
          localSocket.on(event, callback);
        }
      },
      emit: function(event, data, callback) {
        if (localSocket && localSocket.connected) {
          // student:join이나 student:submit_test는 로컬과 클라우드 중 먼저 성공하는 쪽이 응답하도록 래핑
          if (event === 'student:join' || event === 'student:submit_test') {
            localSocket.emit(event, data, (res) => {
              window._pendingJoinCallback = null;
              window._pendingSubmitCallback = null;
              if (callback) callback(res);
            });
          } else {
            localSocket.emit(event, data, callback);
          }
        }

        if (event === 'teacher:create_room') {
          role = 'teacher';
          currentPin = data?.pin || Math.floor(100000 + Math.random() * 900000).toString();
          roomState.pin = currentPin;
          roomState.passage = data?.passage;
          roomState.status = 'waiting';
          subscribeTeacherTopics(currentPin);
          publishRoomState();

          if (callback && (!localSocket || !localSocket.connected)) {
            callback({
              success: true,
              pin: currentPin,
              passage: roomState.passage,
              status: 'waiting',
              students: Array.from(roomState.students.values()),
              localIps: [window.location.hostname || 'localhost'],
              port: window.location.port || '3000'
            });
          }
        } else if (event === 'teacher:update_passage') {
          roomState.passage = data;
          publishRoomState();
          publishToStudents(currentPin, 'room:passage_updated', data, null, true);
          if (callback && (!localSocket || !localSocket.connected)) {
            callback({ success: true, passage: data });
          }
        } else if (event === 'teacher:start_countdown') {
          const countdownSec = data || 3;
          roomState.status = 'countdown';
          for (const s of roomState.students.values()) {
            s.progress = 0; s.cpm = 0; s.accuracy = 100; s.typoCount = 0; s.isCompleted = false; s.rank = null;
          }
          publishToStudents(currentPin, 'room:countdown_started', { countdownSec }, null, true);

          let count = countdownSec;
          const timer = setInterval(() => {
            count--;
            if (count > 0) {
              publishToStudents(currentPin, 'room:countdown_tick', { count }, null, false);
            } else {
              clearInterval(timer);
              roomState.status = 'in_progress';
              roomState.startTime = Date.now();
              publishRoomState();
              publishToStudents(currentPin, 'room:test_started', { startTime: roomState.startTime }, null, true);
              if (!localSocket || !localSocket.connected) {
                triggerLocalEvent('room:test_started', { startTime: roomState.startTime });
              }
            }
          }, 1000);
        } else if (event === 'teacher:finish_test') {
          finishCloudTest();
        } else if (event === 'teacher:reset_room') {
          roomState.status = 'waiting';
          for (const s of roomState.students.values()) {
            s.progress = 0; s.cpm = 0; s.accuracy = 100; s.typoCount = 0; s.isCompleted = false; s.rank = null;
          }
          publishRoomState();
          publishToStudents(currentPin, 'room:reset', { passage: roomState.passage }, null, true);
        } else if (event === 'teacher:kick_student') {
          const targetId = data;
          roomState.students.delete(targetId);
          publishToStudents(currentPin, 'student:kicked', {}, targetId, true);
        } else if (event === 'student:join') {
          role = 'student';
          currentPin = (data?.pin || '').trim();
          myStudentInfo = {
            pin: currentPin,
            name: (data?.name || '').trim(),
            seatNumber: (data?.seatNumber || '-').trim()
          };
          subscribeStudentTopics(currentPin);

          window._pendingJoinCallback = callback;
          publishToTeacher(currentPin, 'student:join', myStudentInfo, true);
          setTimeout(() => {
            if (window._pendingJoinCallback) {
              publishToTeacher(currentPin, 'student:join', myStudentInfo, true);
            }
          }, 1200);
          setTimeout(() => {
            if (window._pendingJoinCallback) {
              publishToTeacher(currentPin, 'student:join', myStudentInfo, true);
            }
          }, 2500);
          setTimeout(() => {
            if (window._pendingJoinCallback) {
              const cb = window._pendingJoinCallback;
              window._pendingJoinCallback = null;
              cb({
                success: false,
                message: '방 번호(PIN)를 다시 확인해 주세요. (선생님 화면에 표시된 6자리 번호)'
              });
            }
          }, 5000);
        } else if (event === 'student:typing_progress') {
          publishToTeacher(currentPin, 'student:typing_progress', data, false);
        } else if (event === 'student:submit_test') {
          window._pendingSubmitCallback = callback;
          publishToTeacher(currentPin, 'student:submit_test', data, true);
          setTimeout(() => {
            if (window._pendingSubmitCallback) {
              const cb = window._pendingSubmitCallback;
              window._pendingSubmitCallback = null;
              cb({ success: true, rank: 1, student: data });
            }
          }, 2000);
        }
      }
    };

    return hybridSocket;
  };
})(window);
