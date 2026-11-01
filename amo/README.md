# Firefox 스토어 배포

## 최초 설정

GitHub 저장소 Settings → Environments에서 `amo-production` 환경을 만들고 Required reviewers에 `one62`를 지정합니다. 혼자 승인할 수 있도록 Prevent self-review는 끕니다. 관리자 승인 생략도 끄고 Deployment branches and tags는 `v*` 태그로 제한합니다. 환경 이름만 선언해서는 승인이 강제되지 않으므로 이 설정을 확인한 뒤 키를 등록하세요.

환경 Secrets에 아래 두 값을 직접 등록합니다. 채팅이나 저장소 파일에 넣지 않습니다.

- `AMO_JWT_ISSUER`: AMO API key / JWT issuer
- `AMO_JWT_SECRET`: AMO API secret / JWT secret

발급: https://addons.mozilla.org/developers/addon/api/key/

기존 등록 항목의 확장 ID는 manifest의 `chzzk-catchup-firefox@local`을 사용합니다. 인증한 API로 기존 항목을 조회하지 못하면 제출을 중단하며 새 항목을 생성하지 않습니다. 현재 심사 대기 버전이 끝난 뒤 다음 새 버전을 준비하세요.

## 버전 준비

1. manifest.json과 package.json 버전을 같은 새 X.Y.Z로 갱신합니다. 이미 제출한 버전을 재사용하지 않습니다.
2. `amo/releases/X.Y.Z/`에 `notes.ko.md`, `notes.en.md`, `reviewer.md`를 작성합니다. reviewer.md는 영어로 이번 변경과 테스트 결과 및 미확인 사항을 적습니다. 공통 메모가 자동으로 앞에 붙습니다.
3. 같은 폴더에 `release.json`을 작성합니다: `{"reviewed": false, "updateListing": false}`.
4. 사용자가 문구를 확인한 뒤 `reviewed`를 true로 바꿉니다. 소개문을 실제 갱신하려는 경우에만 listing.ko.md/listing.en.md를 확인하고 updateListing을 true로 설정합니다.
5. `npm ci`, `npm test`, `npm run check`, `node tools/amo-prepare.mjs vX.Y.Z`를 실행합니다. 결과는 dist/amo/에 생성됩니다. `npx --no-install web-ext lint --source-dir dist/amo/extension --no-config-discovery`로 추가 검사합니다.
6. 검토한 코드와 문구를 커밋·push한 뒤 그 커밋에 `vX.Y.Z` 태그를 만들어 push합니다.
7. Actions의 prepare 결과에서 `amo-review-vX.Y.Z` 아티팩트의 ZIP과 review.md, metadata.json을 확인하고 `amo-production` 배포를 승인합니다.

## 결과와 실패 처리

제출은 Mozilla 심사 완료와 다릅니다. `--approval-timeout 0`으로 제출 후 심사 완료를 기다리지 않습니다. 상태는 AMO Developer Hub에서 확인합니다.

API 사전 검사로 중복 버전, 기존 버전 이하 번호, 심사 대기 중인 listed 버전을 거부합니다. 버전 비교는 이 프로젝트의 X.Y.Z 형식을 지원하며 다른 형식은 수동 확인을 요구합니다. 인증·API 검사 실패 시 제출하지 않습니다.

소개문 갱신은 버전 제출 성공 후 별도 PATCH로 실행됩니다. 따라서 소개문 갱신만 실패했어도 버전은 이미 제출됐을 수 있습니다. 제출 중 오류·타임아웃이 나면 재실행하기 전에 AMO에서 실제 등록 여부를 확인하세요. 이미 제출된 버전이면 전체 job을 재실행하지 말고 Developer Hub에서 필요한 메타데이터만 수정합니다. 워크플로는 심사 취소·버전 삭제·자동 재시도를 하지 않습니다.

현재 심사 중인 버전의 문구를 추측해서 만들지 않도록 releases 폴더는 실제 다음 배포를 준비할 때 생성합니다. 문구가 없거나 reviewed가 false이면 검증 단계에서 중단됩니다.

스킬: `.agents/skills/amo-release/SKILL.md`.

참고: https://extensionworkshop.com/documentation/develop/web-ext-command-reference/ · https://mozilla.github.io/addons-server/topics/api/addons.html
