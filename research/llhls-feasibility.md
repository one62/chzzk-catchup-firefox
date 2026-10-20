# LL-HLS 사용 가능성 조사

대상: 사용자가 제공한 HAR의 방송 채널과 현재 공개 치지직 플레이어. 확장 동작·브라우저 설정은 변경하지 않았다.

## 서버에서 확인

같은 채널의 공개 live-detail API는 HLS와 LLHLS 항목을 제공한다. Origin/Referer를 치지직으로 지정해 각 master와 첫 번째 영상 variant 목록을 조회했다. 인증 URL과 영상 본문은 저장하지 않았다. 결과: llhls-current-summary.json.

- HLS: EXTINF 2초, PART 없음.
- LLHLS: EXTINF 2초, PART-TARGET 1초, 실제 PART DURATION 1초 8개 관측.
- LLHLS: CAN-BLOCK-RELOAD=YES, PART-HOLD-BACK=3.008초.
- PART-HOLD-BACK은 서버가 안내하는 부분 세그먼트 기준 라이브 여유다. PC에서 측정하는 전체 지연이나 강제 최소 버퍼와 동일하지 않다.
- 모든 화질을 조사한 것은 아니며 실제 사용자가 선택한 화질의 전환 성공은 미검증이다.

## 공식 배포 코드에서 확인

공식 플레이어: https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-B7YwD4RF.js

- HLS 컨트롤러 생성 설정에 lowLatencyMode:true가 있다. 단순히 이 값을 켜는 것만으로 일반 목록에 부분 세그먼트가 생기지는 않는다.
- LiveProvider._updateVideoTracks는 응답의 media 배열을 순회한다. _isSupportedMedia는 HLS의 canPlayType을 검사한다.
- _createHLSTrackManipulator는 media.latency를 넘기고, 조작기는 latency === 'lowLatency'일 때 kind='low-latency' 트랙을 만든다.
- pickInitialTrackFromVideoTracks(videoTracks, track, trackKind)는 kind로 필터링할 수 있다.
- 플레이어는 videoTracks의 selected 변경을 관찰하고 소스를 전환하는 경로를 가진다. P2P에서 비-P2P 저지연 트랙으로 변경하는 내부 코드도 존재한다.
- 검사한 이 선택 경로에서 Firefox를 이유로 LL-HLS를 일괄 차단하는 분기는 찾지 못했다. 전체 번들의 모든 경로를 증명한 결과는 아니다.
- LL-HLS에는 내장 catch-up 컨트롤러도 있으므로 확장의 배속 제어와 충돌 여부를 확인해야 한다.

서비스 코드: https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-VdvK-ysl.js

- 화질 후보 구성 함수는 low-latency 계열 트랙이 존재하면 low-latency-p2p / low-latency를 우선한다.
- 따라서 정상적인 기본 선택을 우회하기 전에 실제 선택 트랙, 저지연 트랙 제공 여부, fallback 여부를 읽어야 한다.

## 결론과 다음 구현 후보

서버와 배포 플레이어에는 필요한 기능이 있다. 실제 Firefox 탭에서 사용할 수 있다는 런타임 확정은 아직 아니다. 제출된 HAR는 일반 HLS 형태이며, 왜 선택됐는지 알 수 없다.

먼저 MAIN bridge에서 실제 서비스 플레이어의 트랙 kind/label/selected와 활성 HLS의 lowLatencyMode/partTarget/loadingParts를 읽기 전용으로 확인하는 진단이 필요하다. DOM의 native video.videoTracks와 서비스 플레이어의 가상 트랙 목록은 구분해야 한다.

저지연 트랙이 노출되면 기존 플레이어의 트랙 선택 경로를 사용하는 수동 실험이 우선이다. 새 플레이어 교체나 API 응답 변조는 첫 선택으로 삼지 않는다. 실패 시 기존 트랙 복귀, 사용자 화질 유지, 광고·채널 전환, 내장 배속 충돌을 고려해야 한다.

성공 기준: 실제 부분 세그먼트 요청과 약 1초 단위 버퍼 보충을 확인하고 동일 조건에서 60초 로그/HAR를 동시에 수집한다. 1초는 이 방송에서 관측한 값이며 더 짧은 임의 단위로 바꿀 수 있다고 보장하지 않는다. 수초의 전송 정체는 LL-HLS에서도 발생할 수 있다.
