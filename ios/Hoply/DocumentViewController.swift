import UIKit
import StoreKit
import WebKit
import CryptoKit

final class DocumentViewController: UIViewController, WKScriptMessageHandler {
    private let documentURL: URL
    private var webView: WKWebView!
    private var schemeHandler: ViewerSchemeHandler?
    private var didStartSecurityScope = false
    private var pageCount = 0
    private var currentPageIndex = 0
    private var zoomScale: Double = 1
    private var didRecordSuccessfulOpen = false
    private let pageLabel = UILabel()
    private let titleLabel = UILabel()
    private var originalPayload: DocumentPayload?
    private var editsURL: URL?
    private var isSimpleEditing = false
    private var isMakingOutput = false
    private var editButton: UIBarButtonItem!

    init(documentURL: URL) {
        self.documentURL = documentURL
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "viewer")
        if didStartSecurityScope {
            documentURL.stopAccessingSecurityScopedResource()
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        edgesForExtendedLayout = []
        view.backgroundColor = .systemGroupedBackground
        didStartSecurityScope = documentURL.startAccessingSecurityScopedResource()

        configureNavigation()
        configureWebView()
        loadViewer()
    }

    private func configureNavigation() {
        configureBarAppearance()
        configureTitleView()

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .done,
            primaryAction: UIAction { [weak self] _ in
                Task { await self?.closeDocument() }
            }
        )

        let shareMenu = UIMenu(children: [
            UIAction(title: "원본 공유 (입력 제외)", image: UIImage(systemName: "doc")) { [weak self] _ in
                self?.shareOriginal()
            },
            UIAction(title: "작성한 HWP 공유", subtitle: "원본은 고정 배경 · 새 입력만 편집 가능", image: UIImage(systemName: "square.and.pencil")) { [weak self] _ in
                Task { await self?.shareEditedHWP() }
            },
            UIAction(title: "PDF 공유", image: UIImage(systemName: "doc.richtext")) { [weak self] _ in
                Task { await self?.sharePDF() }
            }
        ])
        let shareButton = UIBarButtonItem(
            image: UIImage(systemName: "square.and.arrow.up"),
            primaryAction: nil,
            menu: shareMenu
        )
        let printButton = UIBarButtonItem(
            image: UIImage(systemName: "printer"),
            primaryAction: UIAction { [weak self] _ in
                Task { await self?.printDocument() }
            }
        )
        editButton = UIBarButtonItem(title: "Edit", style: .plain, target: self, action: #selector(toggleSimpleEdit))
        editButton.accessibilityLabel = "Simple Edit 시작"
        editButton.isEnabled = false
        navigationItem.rightBarButtonItems = [shareButton, printButton, editButton]

        pageLabel.font = .preferredFont(forTextStyle: .footnote)
        pageLabel.textColor = .secondaryLabel
        pageLabel.textAlignment = .center
        pageLabel.text = "- / -"
        pageLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 80).isActive = true

        toolbarItems = [
            UIBarButtonItem(image: UIImage(systemName: "minus.magnifyingglass"), style: .plain, target: self, action: #selector(zoomOut)),
            UIBarButtonItem(systemItem: .flexibleSpace),
            UIBarButtonItem(customView: pageLabel),
            UIBarButtonItem(systemItem: .flexibleSpace),
            UIBarButtonItem(image: UIImage(systemName: "plus.magnifyingglass"), style: .plain, target: self, action: #selector(zoomIn))
        ]
        navigationController?.navigationBar.isTranslucent = false
        navigationController?.toolbar.isTranslucent = false
        navigationController?.setToolbarHidden(false, animated: false)
    }

    private func configureBarAppearance() {
        navigationItem.largeTitleDisplayMode = .never
        navigationController?.navigationBar.prefersLargeTitles = false

        let navigationAppearance = UINavigationBarAppearance()
        navigationAppearance.configureWithOpaqueBackground()
        navigationAppearance.backgroundColor = .systemBackground
        navigationAppearance.titleTextAttributes = [.foregroundColor: UIColor.label]
        navigationController?.navigationBar.standardAppearance = navigationAppearance
        navigationController?.navigationBar.scrollEdgeAppearance = navigationAppearance
        navigationController?.navigationBar.compactAppearance = navigationAppearance

        let toolbarAppearance = UIToolbarAppearance()
        toolbarAppearance.configureWithOpaqueBackground()
        toolbarAppearance.backgroundColor = .systemBackground
        navigationController?.toolbar.standardAppearance = toolbarAppearance
        navigationController?.toolbar.scrollEdgeAppearance = toolbarAppearance
    }

    private func configureTitleView() {
        let titleContainer = UIView(frame: CGRect(x: 0, y: 0, width: 220, height: 44))
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textColor = .label
        titleLabel.textAlignment = .center
        titleLabel.lineBreakMode = .byTruncatingMiddle
        titleLabel.numberOfLines = 1
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        titleContainer.addSubview(titleLabel)
        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: titleContainer.leadingAnchor),
            titleLabel.trailingAnchor.constraint(equalTo: titleContainer.trailingAnchor),
            titleLabel.topAnchor.constraint(equalTo: titleContainer.topAnchor),
            titleLabel.bottomAnchor.constraint(equalTo: titleContainer.bottomAnchor)
        ])
        navigationItem.titleView = titleContainer
        setViewerTitle(documentURL.lastPathComponent)
    }

    private func configureWebView() {
        let configuration = WKWebViewConfiguration()
        let userContentController = WKUserContentController()
        userContentController.add(WeakViewerMessageHandler(target: self), name: "viewer")
        configuration.userContentController = userContentController
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        guard let viewerRoot = Bundle.main.url(forResource: "ViewerBundle", withExtension: nil) else {
            showError(title: "뷰어 리소스가 없습니다", message: "먼저 npm run build:viewer를 실행해 주세요.")
            return
        }

        let handler = ViewerSchemeHandler(resourceRoot: viewerRoot) { [weak self] in
            guard let self else { throw CocoaError(.userCancelled) }
            return try self.readDocumentPayload()
        }
        configuration.setURLSchemeHandler(handler, forURLScheme: "rhwpviewer")
        schemeHandler = handler

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .systemGroupedBackground
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.backgroundColor = .systemGroupedBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.scrollView.panGestureRecognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        view.addSubview(webView)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
    }

    private func loadViewer() {
        guard webView != nil else { return }
        let request = URLRequest(url: URL(string: "rhwpviewer://app/index.html")!)
        webView.load(request)
    }

    private func readDocumentPayload() throws -> DocumentPayload {
        if let originalPayload { return originalPayload }
        let payload = DocumentPayload(data: try Data(contentsOf: documentURL), fileName: documentURL.lastPathComponent)
        // Tie edits to the exact original and its local filename. Imported
        // copies have unique filenames and must not share filled-in values.
        // Never write to documentURL.
        var identity = SHA256()
        identity.update(data: payload.data)
        identity.update(data: Data(documentURL.lastPathComponent.utf8))
        let hash = identity.finalize().map { String(format: "%02x", $0) }.joined()
        editsURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SimpleEdit", isDirectory: true).appendingPathComponent("\(hash).json")
        originalPayload = payload
        return payload
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard
            message.name == "viewer",
            message.frameInfo.isMainFrame,
            let body = message.body as? [String: Any],
            let type = body["type"] as? String
        else { return }

        switch type {
        case "loaded":
            pageCount = body["pageCount"] as? Int ?? 0
            if let fileName = body["fileName"] as? String {
                setViewerTitle(fileName)
            }
            updatePageLabel()
            recordSuccessfulOpenIfNeeded()
            Task { await loadSimpleEdits() }
        case "editsChanged":
            do {
                guard let state = body["state"] as? [String: Any] else { return }
                try persistSimpleEdits(state)
            } catch {
                webView.evaluateJavaScript("window.RHWPViewer.setSaveStatus('저장 실패 · 앱을 닫지 말고 다시 시도해 주세요.')")
                showError(title: "입력을 저장하지 못했습니다", message: error.localizedDescription)
            }
        case "pageChanged":
            currentPageIndex = body["pageIndex"] as? Int ?? currentPageIndex
            updatePageLabel()
        case "renderError":
            let recoverable = body["recoverable"] as? Bool ?? false
            guard !recoverable else { return }
            showError(
                title: "문서를 열 수 없습니다",
                message: body["message"] as? String ?? "알 수 없는 오류가 발생했습니다."
            )
        default:
            break
        }
    }

    private func setViewerTitle(_ fileName: String) {
        title = fileName
        titleLabel.text = fileName
        titleLabel.accessibilityLabel = fileName
    }

    private func updatePageLabel() {
        guard pageCount > 0 else {
            pageLabel.text = "- / -"
            return
        }
        pageLabel.text = "\(min(currentPageIndex + 1, pageCount)) / \(pageCount)"
    }

    private func recordSuccessfulOpenIfNeeded() {
        guard pageCount > 0, !didRecordSuccessfulOpen else { return }
        didRecordSuccessfulOpen = true
        AppReviewPrompt.recordSuccessfulDocumentOpen(from: self)
    }

    @objc private func zoomIn() {
        setZoom(zoomScale + 0.1)
    }

    @objc private func zoomOut() {
        setZoom(zoomScale - 0.1)
    }

    private func setZoom(_ value: Double) {
        zoomScale = min(3, max(0.5, value))
        webView.evaluateJavaScript("window.RHWPViewer.setZoom(\(zoomScale))")
    }

    private func shareOriginal() {
        presentActivity(items: [documentURL], source: navigationItem.rightBarButtonItems?.first)
    }

    @MainActor
    private func loadSimpleEdits() async {
        do {
            guard let editsURL else { return }
            let data = FileManager.default.fileExists(atPath: editsURL.path)
                ? try Data(contentsOf: editsURL) : Data("{\"schema\":1,\"items\":[]}".utf8)
            guard data.count <= 8_000_000 else { throw CocoaError(.fileReadCorruptFile) }
            let parsed = try JSONSerialization.jsonObject(with: data)
            let canonical = try JSONSerialization.data(withJSONObject: parsed)
            guard let json = String(data: canonical, encoding: .utf8) else { throw CocoaError(.fileReadCorruptFile) }
            _ = try await evaluateJavaScript("window.RHWPViewer.loadEdits(\(json))")
            editButton.isEnabled = true
        } catch {
            showError(title: "저장한 입력을 불러오지 못했습니다", message: error.localizedDescription)
        }
    }

    private func persistSimpleEdits(_ state: [String: Any]) throws {
        guard let editsURL, state["schema"] as? Int == 1, state["items"] is [Any] else { throw CocoaError(.fileWriteUnknown) }
        let data = try JSONSerialization.data(withJSONObject: state)
        guard data.count <= 8_000_000 else { throw CocoaError(.fileWriteOutOfSpace) }
        try FileManager.default.createDirectory(at: editsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: editsURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    @objc private func toggleSimpleEdit() {
        guard !isMakingOutput else { return }
        Task { @MainActor in
            do {
                let next = !isSimpleEditing
                let result = try await evaluateJavaScript("window.RHWPViewer.setEditing(\(next))")
                guard result as? Bool == true else {
                    showError(title: "입력이 진행 중입니다", message: "입력창에서 적용 또는 취소를 누른 뒤 완료해 주세요.")
                    return
                }
                isSimpleEditing = next
                isModalInPresentation = next
                editButton.title = next ? "완료" : "Edit"
                editButton.accessibilityLabel = next ? "Simple Edit 완료" : "Simple Edit 시작"
            } catch { showError(title: "편집 모드를 바꿀 수 없습니다", message: error.localizedDescription) }
        }
    }

    @MainActor
    private func closeDocument() async {
        guard !isMakingOutput else { return }
        do {
            if pageCount > 0, editButton.isEnabled {
                guard try await evaluateJavaScript("window.RHWPViewer.isEditBusy()") as? Bool == false else {
                    showError(title: "입력이 진행 중입니다", message: "입력창에서 적용 또는 취소를 누른 뒤 닫아 주세요.")
                    return
                }
                if let state = try await evaluateJavaScript("window.RHWPViewer.getEdits()") as? [String: Any] { try persistSimpleEdits(state) }
            }
            dismiss(animated: true)
        } catch { showError(title: "입력을 저장하지 못했습니다", message: error.localizedDescription) }
    }

    @MainActor
    private func shareEditedHWP() async {
        guard editButton.isEnabled, !isMakingOutput else { return }
        isMakingOutput = true
        let wasModal = isModalInPresentation
        isModalInPresentation = true
        webView.isUserInteractionEnabled = false
        defer { isMakingOutput = false; isModalInPresentation = wasModal; webView.isUserInteractionEnabled = true }
        do {
            _ = try await evaluateJavaScript("window.RHWPViewer.setSaveStatus('서식을 확인하고 HWP를 만드는 중…')")
            let script = "try { return {ok:true, data:await window.RHWPViewer.exportHwp()}; } catch(e) { return {ok:false, error:String(e.message || e)}; }"
            guard let result = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page) as? [String: Any] else { throw CocoaError(.fileWriteUnknown) }
            if result["ok"] as? Bool != true {
                throw NSError(domain: "Hoply.SimpleEdit", code: 1, userInfo: [NSLocalizedDescriptionKey: result["error"] as? String ?? "작성본 HWP를 만들 수 없습니다."])
            }
            guard let base64 = result["data"] as? String, let data = Data(base64Encoded: base64) else { throw CocoaError(.fileWriteUnknown) }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(documentURL.deletingPathExtension().lastPathComponent + "-작성본.hwp")
            try data.write(to: url, options: .atomic)
            _ = try await evaluateJavaScript("window.RHWPViewer.setSaveStatus('원본 서식 검증 완료 · 작성본 HWP 준비됨')")
            presentActivity(items: [url], source: navigationItem.rightBarButtonItems?.first) { try? FileManager.default.removeItem(at: directory) }
        } catch {
            _ = try? await evaluateJavaScript("window.RHWPViewer.setSaveStatus('HWP 저장 실패 · 입력 내용은 앱에 보관되어 있습니다.')")
            showError(title: "작성본 HWP를 만들지 못했습니다", message: error.localizedDescription)
        }
    }

    @MainActor
    private func sharePDF() async {
        guard !isMakingOutput else { return }
        do {
            let pdfURL = try await makeTemporaryPDF()
            presentActivity(items: [pdfURL], source: navigationItem.rightBarButtonItems?.first) {
                try? FileManager.default.removeItem(at: pdfURL)
            }
        } catch {
            showError(title: "PDF를 만들 수 없습니다", message: error.localizedDescription)
        }
    }

    @MainActor
    private func printDocument() async {
        guard !isMakingOutput else { return }
        do {
            let pdfURL = try await makeTemporaryPDF()
            let printController = UIPrintInteractionController.shared
            let printInfo = UIPrintInfo(dictionary: nil)
            printInfo.outputType = .general
            printInfo.jobName = documentURL.deletingPathExtension().lastPathComponent
            printController.printInfo = printInfo
            printController.printingItem = pdfURL
            printController.present(animated: true) { _, _, _ in
                try? FileManager.default.removeItem(at: pdfURL)
            }
        } catch {
            showError(title: "프린트 준비 실패", message: error.localizedDescription)
        }
    }

    @MainActor
    private func makeTemporaryPDF() async throws -> URL {
        guard !isMakingOutput else { throw CocoaError(.userCancelled) }
        isMakingOutput = true
        let wasModal = isModalInPresentation
        isModalInPresentation = true
        defer { isMakingOutput = false; isModalInPresentation = wasModal }
        let wasInteractive = webView.isUserInteractionEnabled
        webView.isUserInteractionEnabled = false
        defer { webView.isUserInteractionEnabled = wasInteractive }
        try await prepareViewerForPrint()
        defer {
            webView.evaluateJavaScript("window.RHWPViewer.clearPrintMode()")
        }

        guard let rects = try await evaluateJavaScript("Array.from(document.querySelectorAll('.page')).map(p => { const r = p.getBoundingClientRect(); return {x:r.x + scrollX, y:r.y + scrollY, width:r.width, height:r.height}; })") as? [[String: Double]], rects.count == pageCount else {
            throw DocumentViewError.printPreparationFailed
        }
        var pages: [CGPDFPage] = []
        for rect in rects {
            guard let x = rect["x"], let y = rect["y"], let width = rect["width"], let height = rect["height"], width > 0, height > 0 else { throw DocumentViewError.printPreparationFailed }
            let configuration = WKPDFConfiguration()
            configuration.rect = CGRect(x: x, y: y, width: width, height: height)
            let data = try await createPDF(configuration: configuration)
            guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider), let page = document.page(at: 1) else { throw DocumentViewError.printPreparationFailed }
            pages.append(page)
        }
        guard let first = pages.first else { throw DocumentViewError.printPreparationFailed }
        let firstBox = first.getBoxRect(.mediaBox)
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: firstBox.width * 0.75, height: firstBox.height * 0.75))
        let data = renderer.pdfData { context in
            for page in pages {
                let box = page.getBoxRect(.mediaBox)
                // SVG dimensions use CSS px (96/in); PDF uses points (72/in).
                let bounds = CGRect(x: 0, y: 0, width: box.width * 0.75, height: box.height * 0.75)
                context.beginPage(withBounds: bounds, pageInfo: [:])
                let cg = context.cgContext
                cg.saveGState()
                cg.translateBy(x: 0, y: bounds.height)
                cg.scaleBy(x: 0.75, y: -0.75)
                cg.translateBy(x: -box.minX, y: -box.minY)
                cg.drawPDFPage(page)
                cg.restoreGState()
            }
        }
        let baseName = documentURL.deletingPathExtension().lastPathComponent
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let outputURL = directory
            .appendingPathComponent("\(baseName)-Hoply.pdf")
        try data.write(to: outputURL, options: .atomic)
        return outputURL
    }

    @MainActor
    private func prepareViewerForPrint() async throws {
        guard try await evaluateJavaScript("window.RHWPViewer.isEditBusy()") as? Bool == false else { throw DocumentViewError.printPreparationFailed }
        let result = try await evaluateJavaScript("Boolean(window.RHWPViewer.prepareForPrint())")
        guard result as? Bool == true else {
            throw DocumentViewError.printPreparationFailed
        }
        webView.scrollView.setContentOffset(.zero, animated: false)
        webView.setNeedsLayout()
        webView.layoutIfNeeded()
        try await Task.sleep(nanoseconds: 100_000_000)
    }

    @MainActor
    private func evaluateJavaScript(_ script: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script) { result, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: result)
                }
            }
        }
    }

    @MainActor
    private func createPDF(configuration: WKPDFConfiguration) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            webView.createPDF(configuration: configuration) { result in
                switch result {
                case .success(let data):
                    continuation.resume(returning: data)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func presentActivity(
        items: [Any],
        source: UIBarButtonItem?,
        completion: (() -> Void)? = nil
    ) {
        let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)
        activity.popoverPresentationController?.barButtonItem = source
        activity.completionWithItemsHandler = { _, _, _, _ in completion?() }
        present(activity, animated: true)
    }

    private func showError(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default))
        present(alert, animated: true)
    }
}

private final class WeakViewerMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

@MainActor
private enum AppReviewPrompt {
    private static let successfulOpenCountKey = "appReviewPrompt.successfulOpenCount"
    private static let didRequestReviewKey = "appReviewPrompt.didRequestReview"
    private static let minimumSuccessfulOpens = 3

    static func recordSuccessfulDocumentOpen(from viewController: UIViewController) {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: didRequestReviewKey) == false else { return }

        let successfulOpenCount = defaults.integer(forKey: successfulOpenCountKey) + 1
        defaults.set(successfulOpenCount, forKey: successfulOpenCountKey)

        guard successfulOpenCount >= minimumSuccessfulOpens else { return }
        guard let windowScene = viewController.view.window?.windowScene else { return }

        defaults.set(true, forKey: didRequestReviewKey)
        SKStoreReviewController.requestReview(in: windowScene)
    }
}

private enum DocumentViewError: LocalizedError {
    case printPreparationFailed

    var errorDescription: String? {
        switch self {
        case .printPreparationFailed:
            return "문서가 아직 PDF/프린트용으로 준비되지 않았습니다."
        }
    }
}
