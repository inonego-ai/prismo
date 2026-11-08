# Prismo — 오픈소스 및 외부 SDK 라이선스 관리

> 2026-11-06 기준. 현재 잠금 파일과 Android 빌드 구성을 확인한 결과이며 법률 자문은 아니다.
> 이 문서는 프로젝트 배포에 필요한 라이선스 정보와 확인 범위를 기록한다.

## 1. 배포 구성에 따라 구분

- **Android APK에 포함:** AndroidX/Compose, Kotlin 런타임, Retrofit/OkHttp 등의 Maven 구성요소와
  WebView용 JavaScript 번들(diff2html 파서, highlight.js, DOMPurify, marked).
- **Windows PC 프로그램에서 사용:** Fastify, qrcode, Electron, Lucide SVG 아이콘 등. 이들을 설치하거나
  PC Agent를 번들 배포하는 경우 해당 패키지들의 라이선스 고지를 지켜야 한다.
- **외부 설치 도구:** Git CLI(GPL), Node.js, Android SDK,
  JDK, Gradle 등은 현재 Prismo APK/Windows 앱 바이너리에 함께 넣어 배포하지 않는다.
- **Prismo 원본 소스:** [MIT License](../LICENSE). 제3자 구성요소에는 각각의 라이선스가 적용된다.

## 2. Android WebView 렌더러 — APK에 번들됨 (실제 설치 버전)

| 라이브러리 | 확인 버전 | 라이선스 | 코드/출처 |
| --- | --- | --- | --- |
| diff2html | 3.4.56 | MIT | https://github.com/rtfpessoa/diff2html |
| highlight.js | 11.12.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| DOMPurify | 3.4.17 | MPL-2.0 OR Apache-2.0 (Apache-2.0 고지 수록) | https://github.com/cure53/DOMPurify |
| marked | 15.0.12 | MIT | https://github.com/markedjs/marked |

- 위 **네 패키지는 esbuild 실제 번들 입력 메타파일**과 npm 설치 패키지에서 확인했다. diff2html은 Git 패치 파서만 번들에 포함하며, 사용하지 않는 HTML 템플릿 엔진은 제외한다.
- 라이선스 **원문과 저작권 고지**는 npm 패키지의 LICENSE 파일을 그대로 이용해
  [RENDERER_THIRD_PARTY_NOTICES.txt](RENDERER_THIRD_PARTY_NOTICES.txt)에 저장한다.
- renderer 빌드(`npm run build`)가 라이선스 검사/복사까지 수행하고,
  Android APK의 `assets/renderer-licenses.txt`에도 포함된다.
- 버전 업그레이드 시 라이선스 종류가 바뀌면 생성 스크립트가 오류를 내도록 했다.
  번들 입력에 새 패키지가 추가되면 생성 스크립트의 목록도 확인·갱신해야 한다.
- MIT, BSD-3-Clause, Apache-2.0은 모두 상용 배포가 가능한 허용적 라이선스이나,
  각각 저작권 고지/라이선스 텍스트/조건을 보존해야 한다.
- Apache-2.0은 NOTICE 파일 제공 여부, 수정 고지 등의 조건도 배포 전에 별도 점검한다.

## 3. Android/Maven 의존성

| 라이브러리·도구 | 명시된 버전/역할 | 주요 조건 |
| --- | --- | --- |
| Kotlin 및 kotlin-stdlib | 2.3.21 | Apache-2.0 |
| Jetpack Compose / AndroidX | Compose BOM 2025.10.00 및 기타 AndroidX | 일반적으로 Apache-2.0; 개별 POM 확인 |
| Retrofit | 2.11.0 | Apache-2.0 |
| OkHttp | 4.12.0 | Apache-2.0 |
| Iroh Android FFI AAR (`computer.iroh:iroh-android`) | 1.2.0 | MIT OR Apache-2.0 |
| JNA Android AAR | 5.15.0 | LGPL-2.1 OR Apache-2.0 |
| Retrofit Gson Converter / Gson | Converter 2.11.0 / Gson 2.10.1 (Gradle 해석 결과) | Apache-2.0 |
| Google Code Scanner | play-services-code-scanner 16.1.0 | Google Play services SDK 약관 및 포함된 OSS 고지 |
| Android OSS 라이선스 고지 | docs/ANDROID_LIBRARY_NOTICES.txt | APK에 수록되는 직접 관리 고지(임시 수집 보완) |
| OSS licenses Gradle plugin | 0.13.0 (빌드 전용) | Maven POM 라이선스 메타데이터 수집 |

- Google 공식 가이드에 따라 OSS 라이선스 Gradle 플러그인을 적용했다.
- 이 플러그인은 빌드 시 Maven/POM의 라이선스 정보를 수집하고 APK에
  `res/raw/third_party_license_metadata` 및 `res/raw/third_party_licenses`를 생성한다.
- **주의:** 현재 Debug 빌드에서는 Google OSS 플러그인의 출력이 자동 생성된 전체 목록이 아닌 `Debug License Info` 안내문이다.
  따라서 앱의 **Android 라이브러리 라이선스** 메뉴는 유지되는 수동 고지 파일(`docs/ANDROID_LIBRARY_NOTICES.txt`)을 표시한다.
- WebView/JS 라이브러리는 Maven으로 해결하지 않으므로 **별도 렌더러 라이선스 화면**을 구현했다.
- 수동 Android 고지는 현재 명시적인 주요 구성요소의 고지이며 모든 전이적 의존성의 고지를 완전히 보증하지는 않는다.
- 공개 릴리스 전 Release 변형의 자동 생성 Maven 고지·전체 전이적 의존성 목록을 확인하고 수동 고지를 보완해야 한다.
- Google Play services 구성요소는 *무조건 Apache-2.0 오픈소스라고 간주하면 안 된다.*
  Google의 SDK/서비스 조건과 포함된 오픈소스 라이선스가 동시에 적용될 수 있다.

공식 가이드:
- https://developers.google.com/android/guides/opensource
- https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner

## 4. Windows GUI와 Agent 및 개발 도구 (직접 의존성)

| 패키지 | 확인 버전 | 라이선스 | 용도 |
| --- | --- | --- | --- |
| electron | 42.11.16 | MIT (Chromium 관련 고지 별도) | Windows GUI 런타임 |
| qrcode | 1.5.4 | MIT | PC GUI에서 QR 생성 |
| @number0/iroh 및 Windows 네이티브 모듈 | 1.2.0 | MIT OR Apache-2.0 | QUIC P2P·릴레이 전송 |
| Lucide SVG 정적 아이콘 | 원본 1.67.0 | ISC (일부 Feather 유래 아이콘 MIT) | PC GUI에 포함한 SVG 자산. 설치 의존성은 없음 |
| electron-builder | 26.18.0 | MIT | Windows 패키징(개발 도구) |
| electron-updater | 6.8.11 | MIT | GitHub Releases Windows 설치형 업데이트 |
| fastify | 5.12.8 | MIT | Windows API 런타임 |
| proper-lockfile | 4.1.2 | MIT | GUI·CLI의 저장소 설정 변경에 필요한 파일 잠금 |
| typescript | 5.9.3 | Apache-2.0 | 빌드 전용 |
| tsx | 4.23.15 | MIT | 개발 전용 |
| esbuild | 0.25.12 | MIT | 렌더러 빌드 전용 |

- PC GUI의 Lucide SVG 아이콘은 `desktop/THIRD_PARTY_NOTICES.txt`에 ISC 및 Feather 유래 MIT 고지를 포함한다.
- PC GUI는 Electron 런타임과 QR 생성 패키지를 포함한다. Windows 포터블·설치형 최종 배포물은 Electron에서 제공하는 Chromium 고지 및 포함된 npm 라이브러리 고지를 별도로 대조해야 한다.
- PC Agent를 패키징할 경우 Fastify 하위 의존성까지 별도의 라이선스 인벤토리/고지가 필요하다.
- npm 잠금 파일들은 설치된 실제 버전 추적을 위한 기준이며, 개발 전용 패키지는 앱 바이너리에 포함되지 않는다.

## 5. 외부 설치 도구와 프로젝트 라이선스의 관계

- **Git CLI:** Git은 GPLv2 계열. Prismo는 외부 설치된 Git 명령을 프로세스로 호출하고,
  Git 자체를 수정·번들·재배포하지 않는다. 이 사용만으로 Prismo 소스를 GPL로 배포해야 한다고 단정하지 않는다.
- **Iroh:** Windows의 Node.js 네이티브 모듈과 Android Maven 라이브러리를 앱에 포함한다. MIT 또는 Apache-2.0 선택 조건, 관련 저작권·고지를 배포물에서 확인한다. 기본 릴레이·탐색 인프라는 코드 라이선스와 별개의 서비스 운영 조건이 적용될 수 있다.
- **Android SDK/Build Tools:** 앱을 빌드하는 도구이며, Android SDK 사용권 계약이 적용된다.
  SDK를 APK에 재배포하지 않는다.
- **Prismo LICENSE:** MIT License. 제3자 구성요소의 별도 고지와 조건은 유지해야 한다.

## 6. 공개 배포 전 체크리스트

- [ ] 최종 앱과 Windows PC 프로그램 배포 형태 결정
- [ ] `npm ci`와 Renderer 재빌드로 실제 버전 및 원문 고지 갱신
- [ ] Android Gradle의 런타임 종속 관계·Maven POM 라이선스 자동 고지와 수동 Android 고지 대조
- [ ] APK에 Renderer notices와 Google OSS 데이터가 포함되는지 검사
- [ ] 설정 화면의 두 라이선스 페이지를 실제 삼성폰에서 확인
- [ ] Apache-2.0 컴포넌트의 NOTICE 및 수정 여부 확인, 필요 시 고지 추가
- [ ] PC Agent를 번들링할 경우 모든 포함된 npm 패키지의 라이선스 파일과 저작권 고지 유지
- [ ] 최종 EXE·APK의 의존성 및 고지를 대조한 뒤 GitHub Actions 변수 `PRISMO_LICENSE_REVIEWED_SHA`를 해당 릴리스 커밋 SHA로 설정 (일치하지 않으면 게시 차단)
- [ ] 앱 자체의 민감정보/로컬 소스코드 접근 정책과 개인정보 고지 점검

최신 라이브러리 버전을 실제로 반영하는 경우 이 문서의 확인 버전도 함께 갱신한다.
