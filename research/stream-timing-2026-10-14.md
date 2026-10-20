# 치지직 스트림 시간 정보 확인

2026-10-14 21:56 KST에 공개 라이브 API와 미디어 목록을 조사했다. 확장의 재생 동작은 변경하지 않았다.

## 실제 목록에서 확인한 사실

- 공개 라이브 3개에서 HLS와 LLHLS 재생 주소가 모두 제공됐다.
- 그중 2개 방송의 HLS·LLHLS 첫 번째 영상 변형 목록, 총 4개에서 `EXT-X-PROGRAM-DATE-TIME`을 확인했다.
- 각 목록에 8개 또는 15개의 날짜·시간 태그가 있었고 완성 세그먼트와 연결할 수 있었다. LLHLS에는 부분 세그먼트와 `PART-HOLD-BACK`도 있었다.
- 나머지 1개 방송은 목록 조사에 실패했다. 시간 태그가 없다는 결과가 아니다.
- 실제 Firefox 탭의 선택 화질·재생 경로나 활성 메타데이터 큐를 직접 관측한 결과는 아니다.

예시 태그:

```text
#EXT-X-PROGRAM-DATE-TIME:2026-10-14T12:56:29.306Z
```

구조화된 관측값은 [stream-timing-2026-10-14.json](./stream-timing-2026-10-14.json)에 저장했다. 임시 인증 주소나 영상 세그먼트는 저장하지 않았다.

## 공개 플레이어 코드에서 확인한 사실

현재 페이지의 [index-VdvK-ysl.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-VdvK-ysl.js)는 `__getLiveInfo().latency`를 내부 `srcObject._getLiveLatency()`에서 얻는다. 밀리초를 정수로 내림 처리한다.

[player-vendor-B7YwD4RF.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-B7YwD4RF.js)의 `_getLiveLatency()`는 활성 텍스트 트랙 큐에서 `com.navercorp.nmss.timestamp`를 찾고 JSON의 `ingest-utc`를 사용한다. 계산은 다음과 동등하다.

```text
플레이어 지연(ms)
  = Date.now()
  - ingest-utc
  - (현재 재생 위치 - 메타데이터 큐 시작 위치) × 1000
```

해당 큐가 없거나 라이브로 판단되지 않으면 미확인(NaN)을 반환한다. 캐치업은 이 API 결과를 초로 바꿔 표시한다. 치즈 플래터는 내부 함수를 직접 읽으며 Chzzk Latency Display는 공개 래퍼를 읽은 후 설정된 인코딩 추정 시간을 더한다. 두 확장의 원본은 같은 내부 함수임을 이번 조사에서 확인했다.

플레이어 번들의 HLS 구현은 PDT를 파싱하고, 현재 미디어 위치를 프로그램 시각으로 연결하는 `playingDate`도 제공한다. 특정 Firefox 탭에서 해당 HLS 인스턴스가 노출되는지는 별도 관측이 필요하다.

## 해석과 한계

`ingest-utc`라는 이름상 네이버 수신 시점을 기준으로 한 메타데이터로 해석할 수 있다. 정확히 어느 서버 단계에서 찍는지는 별도 문서나 송출 시계 비교로 검증하지 않았다. 따라서 촬영·인코딩·송출 업로드 전체를 포함한 실측 지연으로 단정하지 않는다.

PDT와 `ingest-utc`는 다른 기준일 수 있으므로 두 값을 무조건 동일하게 취급하면 안 된다. HLS 규격에서 PDT는 세그먼트 첫 샘플과 절대 시각을 연결하는 값이며 촬영 시각이라고 보장하지 않는다.

조사 시 HTTP Date 헤더와 PC UTC 시각 사이에 약 2~3초 차이가 관측됐다. 그 결과 PC 시각에서 목록 끝 시각을 뺀 일부 값이 음수였다. HTTP Date는 초 단위이고 서버 시계도 별도이므로 어느 쪽이 정확한지는 이 조사만으로 확정할 수 없다. JSON의 `advertisedEdgeAgeSeconds`는 시계 차이와 목록 기준을 포함한 진단값이며 실제 지연이 아니다. 플레이어의 Date.now() 기반 계산도 PC 시계 차이의 영향을 받는다.

별도 PDT 지표를 추가한다면 현재 재생 중인 세그먼트·부분 세그먼트와 미디어 시간의 대응, 불연속 구간, 시계 차이를 처리해야 한다. 최신 PDT 태그를 현재 시각에서 빼는 방식만으로 시청 지연을 계산하면 안 된다.

## 재현

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/inspect-stream-timing.ps1
```

실행 시점에 공개 라이브 목록을 다시 선택하므로 방송과 결과가 달라질 수 있다. 네트워크 접근이 필요하다.

참고: [RFC 8216 §4.3.2.6](https://datatracker.ietf.org/doc/html/rfc8216#section-4.3.2.6), [Apple HLS authoring specification](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html).
