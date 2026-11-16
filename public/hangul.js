// 한글 유니코드 분해 및 타자수(키스트로크) 계산 유틸리티

var HangulUtil = (function() {
  const CHOSUNG = [
    'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
    'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
  ];

  const JUNGSUNG = [
    'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
    'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'
  ];

  const JONGSUNG = [
    '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
    'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
    'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
  ];

  // 단일 자모별 타수 (표준 2벌식 키보드 기준 글쇠 누름 횟수)
  const STROKE_MAP = {
    // 기본 자음 (단타: 1, 쌍자음: Shift+키 = 2)
    'ㄱ': 1, 'ㄲ': 2, 'ㄴ': 1, 'ㄷ': 1, 'ㄸ': 2, 'ㄹ': 1, 'ㅁ': 1,
    'ㅂ': 1, 'ㅃ': 2, 'ㅅ': 1, 'ㅆ': 2, 'ㅇ': 1, 'ㅈ': 1, 'ㅉ': 2,
    'ㅊ': 1, 'ㅋ': 1, 'ㅌ': 1, 'ㅍ': 1, 'ㅎ': 1,
    // 겹받침
    'ㄳ': 2, 'ㄵ': 2, 'ㄶ': 2, 'ㄺ': 2, 'ㄻ': 2, 'ㄼ': 2, 'ㄽ': 2,
    'ㄾ': 2, 'ㄿ': 2, 'ㅀ': 2, 'ㅄ': 2,
    // 기본 모음
    'ㅏ': 1, 'ㅐ': 1, 'ㅑ': 1, 'ㅒ': 2, 'ㅓ': 1, 'ㅔ': 1, 'ㅕ': 1,
    'ㅖ': 2, 'ㅗ': 1, 'ㅛ': 1, 'ㅜ': 1, 'ㅠ': 1, 'ㅡ': 1, 'ㅣ': 1,
    // 복합 모음
    'ㅘ': 2, // ㅗ + ㅏ
    'ㅙ': 2, // ㅗ + ㅐ (또는 ㅗ+ㅏ+ㅣ)
    'ㅚ': 2, // ㅗ + ㅣ
    'ㅝ': 2, // ㅜ + ㅓ
    'ㅞ': 2, // ㅜ + ㅔ
    'ㅟ': 2, // ㅜ + ㅣ
    'ㅢ': 2  // ㅡ + ㅣ
  };

  /**
   * 한 글자(char)의 타수(키스트로크)를 계산
   */
  function getCharStrokes(char) {
    if (!char) return 0;
    const code = char.charCodeAt(0);

    // 완성형 한글 (가 ~ 힣 : 0xAC00 ~ 0xD7A3)
    if (code >= 0xac00 && code <= 0xd7a3) {
      const offset = code - 0xac00;
      const choIdx = Math.floor(offset / (21 * 28));
      const jungIdx = Math.floor((offset % (21 * 28)) / 28);
      const jongIdx = offset % 28;

      const cho = CHOSUNG[choIdx];
      const jung = JUNGSUNG[jungIdx];
      const jong = JONGSUNG[jongIdx];

      let strokes = (STROKE_MAP[cho] || 1) + (STROKE_MAP[jung] || 1);
      if (jong) {
        strokes += (STROKE_MAP[jong] || 1);
      }
      return strokes;
    }

    // 한글 자모 개별 문자 (ㄱ ~ ㅣ : 0x3131 ~ 0x3163)
    if (STROKE_MAP[char]) {
      return STROKE_MAP[char];
    }

    // 영문 대문자, 특수문자 Shift 조합 등
    if (/[A-Z!@#$%^&*()_+{}|:"<>?~]/.test(char)) {
      return 2;
    }

    // 일반 영문 소문자, 숫자, 공백 등
    return 1;
  }

  /**
   * 전체 텍스트의 총 타수 계산
   */
  function getTotalStrokes(text) {
    if (!text) return 0;
    let strokes = 0;
    for (let i = 0; i < text.length; i++) {
      strokes += getCharStrokes(text[i]);
    }
    return strokes;
  }

  /**
   * 원문 텍스트와 입력 텍스트를 비교하여
   * - 맞은 타수 (validStrokes)
   * - 틀린 글자 수 (typoCount)
   * - 정확도 (accuracy %)
   * - 진행률 (progress %)
   * - 글자별 일치 상태 배열 반환
   */
  function compareText(targetText, inputText) {
    const targetLen = targetText.length;
    const inputLen = inputText.length;
    let typoCount = 0;
    let validStrokes = 0;
    let totalTypedStrokes = 0;
    const charStates = []; // 'correct', 'error', 'pending'

    for (let i = 0; i < targetLen; i++) {
      const targetChar = targetText[i];
      if (i < inputLen) {
        const inputChar = inputText[i];
        const inputStrokes = getCharStrokes(inputChar);
        totalTypedStrokes += inputStrokes;

        if (targetChar === inputChar) {
          charStates.push('correct');
          validStrokes += getCharStrokes(targetChar);
        } else {
          charStates.push('error');
          typoCount++;
        }
      } else {
        charStates.push('pending');
      }
    }

    // 목표 길이를 초과해서 친 경우도 오타로 산정
    if (inputLen > targetLen) {
      typoCount += (inputLen - targetLen);
      for (let i = targetLen; i < inputLen; i++) {
        totalTypedStrokes += getCharStrokes(inputText[i]);
      }
    }

    // 정확도: 친 글자 중 맞은 글자의 비율
    let accuracy = 100;
    if (inputLen > 0) {
      const correctChars = Math.max(0, inputLen - typoCount);
      accuracy = Math.round((correctChars / inputLen) * 100);
      if (accuracy < 0) accuracy = 0;
    }

    // 진행률: 목표 문장 대비 입력 길이 비율 (최대 100%)
    let progress = Math.min(100, Math.round((inputLen / targetLen) * 100));

    return {
      typoCount,
      validStrokes,
      totalTypedStrokes,
      accuracy,
      progress,
      charStates,
      isCompleted: inputLen >= targetLen
    };
  }

  /**
   * 분당 타수(CPM: Characters Per Minute) 계산
   */
  function calculateCPM(validStrokes, elapsedSeconds) {
    if (elapsedSeconds <= 0 || validStrokes <= 0) return 0;
    const cpm = Math.round((validStrokes / elapsedSeconds) * 60);
    return Math.max(0, cpm);
  }

  return {
    getCharStrokes,
    getTotalStrokes,
    compareText,
    calculateCPM
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HangulUtil;
}
