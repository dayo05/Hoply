<p align="center">
  <img src="ios/Hoply/Assets.xcassets/AppIcon.appiconset/Icon-1024.png" alt="Hoply logo" width="120">
</p>

<h1 align="center">Hoply</h1>

<p align="center">
  iPhone과 iPad에서 HWP / HWPX 문서를 여는 읽기 전용 뷰어
</p>

<p align="center">
  <a href="https://apps.apple.com/us/app/hoply/id6770157807"><strong>원본 Hoply 받기 (App Store)</strong></a>
</p>

Hoply는 한컴오피스 문서 형식인 `.hwp`와 `.hwpx` 파일을 iOS 기기에서 빠르게 열어볼 수 있는 문서 뷰어입니다. 파일 앱이나 다른 앱의 공유 메뉴로 문서를 열고, 필요한 경우 원본이나 PDF로 다시 공유하거나 AirPrint로 인쇄할 수 있습니다.

## Dayo 수정판 설치

이 fork의 수정판은 **AltStore Classic**에서 설치할 수 있습니다. iOS / iPadOS 16.0 이상을 지원합니다.

**AltStore 소스: [Dayo's source](https://altsource.ddayo.me/source.json)**

```text
https://altsource.ddayo.me/source.json
```

1. iPhone / iPad에 AltStore Classic을 설치합니다. 처음 사용하는 경우 공식 [macOS 설치 안내](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos) 또는 [Windows 설치 안내](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)를 따라 AltServer와 AltStore Classic을 준비하세요.
2. 컴퓨터에서 **AltServer**를 실행하고, 기기와 컴퓨터를 같은 Wi-Fi에 연결하거나 USB로 연결합니다.
3. 기기에서 AltStore Classic을 열고 **Sources (소스)** 화면의 **+** 버튼을 누릅니다.
4. 위 소스 주소를 붙여 넣고 **Add Source**를 눌러 **Dayo's source**를 추가합니다.
5. 소스에 표시된 **Hoply**를 선택하고 **FREE / 설치** 버튼을 눌러 설치합니다.
6. 설치한 Hoply를 실행하거나, 파일 앱에서 `.hwp` / `.hwpx` 문서를 Hoply로 열면 됩니다.

무료 Apple ID로 설치한 앱은 서명 유효 기간이 7일입니다. 만료 전에 AltServer에 연결한 상태에서
AltStore Classic의 **My Apps → Refresh All**로 갱신하세요. 자세한 내용은 공식 [앱 갱신 안내](https://faq.altstore.io/altstore-classic/your-altstore)를 참고하세요.

## 주요 기능

- `.hwp` / `.hwpx` 문서 열람
- 파일 앱과 "다른 앱에서 열기" 지원
- Files 등에서 바로 미리 볼 수 있는 Quick Look 확장
- 원본 문서 공유와 PDF 공유
- AirPrint 인쇄
- iPhone / iPad 지원

## 조용한 문서 뷰어

Hoply는 읽기 전용 앱입니다. 문서를 편집하거나 원본 파일을 수정하지 않고, 문서를 보는 일에만 집중합니다.

문서는 기기 안에서 렌더링됩니다. 앱 자체는 계정, 로그인, 분석, 광고 SDK를 사용하지 않으며, 문서 내용을 외부 서버로 전송하지 않습니다. 공유나 인쇄처럼 사용자가 직접 선택한 동작은 iOS의 표준 시스템 기능을 통해 처리됩니다.

## 지원과 문의

- 이 fork의 문의·버그 제보·기능 제안: [self@ddayo.me](mailto:self@ddayo.me)
- 개인정보 처리방침: [한국어](https://www.chkwon.net/Hoply/privacy-policy.html) / [English](https://www.chkwon.net/Hoply/privacy-policy.en.html)

## 기반 기술

Hoply는 오픈소스 HWP / HWPX 렌더링 라이브러리인 [`@rhwp/core`](https://github.com/edwardkim/rhwp)를 앱 안에 번들해 사용합니다. App Store 빌드에서는 원격 서버로부터 실행 코드를 내려받지 않습니다.

"Hoply"라는 이름은 [HOP](https://github.com/golbin/hop)에 대한 오마주입니다. 이 앱의 코드는 HOP에서 가져오지 않았고, HOP에 의존하지도 않습니다.

본 앱은 Hancom Inc.와 제휴하거나 후원받은 제품이 아닙니다. "HWP", "HWPX", "Hancom" 등은 각 권리자의 상표입니다.

## 개발자 문서

빌드, 아이콘 재생성, 버전 관리, App Store 배포 절차는 [Development and Release](docs/development-and-release.md)를 참고하세요.
