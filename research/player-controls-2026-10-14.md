# 치지직 기본 컨트롤 표시 규칙

2026-10-14에 공개 [치지직 라이브 페이지](https://chzzk.naver.com/live/7ce8032370ac5121dcabce7bad375ced)의 HTML에서 아래 두 CSS 주소를 확인하고 실제 규칙을 읽었다. 로그인이나 Firefox 프로필 변경은 하지 않았다.

- [index-B5SHICxp.css](https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/index-B5SHICxp.css)
- [player-vendor-BDJ3c8a1.css](https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/player-vendor-BDJ3c8a1.css)

## 확인한 원인

`.pzp-pc__bottom-buttons-left`와 `.pzp-pc__bottom-buttons-right`는 flex 컨테이너이며 자체 opacity 전환은 없다. 개별 실시간·재생·음량 컨트롤에 표시 규칙이 있으므로 일반 span을 컨테이너에 넣는 것만으로는 같이 사라지지 않는다.

서비스 CSS의 실제 실시간 컨트롤 규칙은 다음과 같다.

```css
.live_time {
  opacity: 0;
  white-space: nowrap;
  transition-property: opacity;
  transition-duration: .2s;
}
.pzp-pc.pzp-pc--controls .live_time { opacity: 1; }
```

벤더 CSS의 `.pzp-pc__live-time`, `.pzp-pc__playback-switch`, `.pzp-pc__volume-control`도 같은 `opacity: 0`, `transition-property: opacity`, `transition-duration: .2s`를 가지며 `.pzp-pc.pzp-pc--controls` 상태에서 `opacity: 1`로 바뀐다. 별도 `transition-timing-function`은 이 규칙에 없으므로 CSS 기본값인 ease를 사용한다.

## 적용

지연 span에 실제 기준 컨트롤의 `.live_time` 클래스를 함께 넣는다. 서비스 실시간 컨트롤이 없는 의미 기반 대체 탐색에서는 `.pzp-pc__live-time`을 사용한다. 마우스 이벤트나 별도 대기 타이머 없이 플레이어의 `pzp-pc--controls` 상태와 원본 CSS가 지연 표시를 직접 전환한다.

`.live_time` 자체에는 width, position, float, pointer-events 규칙이 없다. 버튼의 외형·도움말 스타일은 `.live_time_button` 및 그 후손에 적용되며 지연 span에는 해당 후손을 만들지 않는다. 벤더 대체 클래스의 추가 규칙은 라이브 아님·재생 전·종료·대화상자 상태의 `display: none`이다. inline display/opacity/transition을 지정하지 않아 이 숨김 규칙과 종료·미니플레이어의 상위 숨김 규칙도 유지한다.

지연 span 역시 `.live_time`에 해당하게 되므로 탐색 단계에서 확장 소유 클래스 `.chzzk-catchup-latency`는 제외한다. 네이티브 실시간 버튼이 사라진 뒤 라벨이 자기 자신을 기준 컨트롤로 선택하는 문제를 막는다.

## 글자 높이와 버퍼 표시

서비스 CSS의 `.live_time .live_time_button`는 `height: 36px`, `line-height: 36px`, `display: flex`, `align-items: center`이고 안쪽 `.live_time_text`는 `font-size: 13px`, `line-height: 16px`이다. 바깥 `.pzp-pc__bottom-buttons-left/right`도 `align-items: center`이므로 같은 16px 글자 줄 높이를 사용하면 네이티브 실시간 글자와 세로 중앙이 일치한다. 기존 라벨의 12px 글꼴과 상속된 줄 높이는 이 기준과 달랐다.

라벨은 실제 네이티브 `.live_time_text` 또는 `.pzp-live-time__text`의 computed font family, size, weight, style, line height, letter spacing을 읽어 공유한다. computed style을 읽을 수 없는 DOM fixture 등에서는 원본 CSS의 13px / 16px을 기본값으로 사용한다. 상수 top 위치나 transform으로 글자를 이동시키지 않는다. 벤더 글자의 `vertical-align: top`, `margin-top: 10px`는 36px 컨트롤에 16px 글자를 놓는 배치 규칙이며 라벨은 바깥 flex의 중앙 배치로 같은 줄 높이를 맞춘다.

표시는 `지연 1.23초 · 버퍼 2.34초` 형식이다. 지연은 호출자가 넘기는 최근 5초 평균이고 버퍼는 현재 재생 위치부터 이어진 연속 버퍼의 원본 초 값이다. 라벨은 버퍼를 평균 내거나 지연으로 대체하지 않으며, 읽지 못한 값은 각각 `—`로 표시한다.

## 검증 범위

라벨의 클래스·배치·버튼 보존·재배치·삭제는 Node DOM fixture 회귀 테스트로 확인했다. 실제 재생 중인 Firefox 화면에서 페이드 중간 프레임, 마우스 진입·이탈, 키보드 포커스, 전체화면은 직접 관측하지 않았다. 전환의 동시성은 현재 원본 CSS의 동일 상태 선택자 및 전환 클래스 공유를 근거로 한다.
