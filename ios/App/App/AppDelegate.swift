import UIKit
import Capacitor
import WebKit
import UniformTypeIdentifiers
import Darwin

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// Documents use the official IndexedDB adapter in the shared WebView.
class JockiViewController: CAPBridgeViewController {
    private var diagnosticsDelegate: RuntimeNavigationDiagnostics?
    private var mainFrameBridge: MainFrameBridge?
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TimersPlugin())
        bridge?.registerPluginInstance(RuntimeDiagnosticsPlugin())
        bridge?.registerPluginInstance(VaultFilesPlugin())
        if let webView = webView, let delegate = webView.navigationDelegate {
            if let handler = delegate as? WKScriptMessageHandler {
                let gate = MainFrameBridge(handler)
                mainFrameBridge = gate
                webView.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
                webView.configuration.userContentController.add(gate, name: "bridge")
            }
            let proxy = RuntimeNavigationDiagnostics(delegate) { [weak self] in
                self?.showWebContentFailure()
            }
            diagnosticsDelegate = proxy
            webView.navigationDelegate = proxy
        }
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
    }
    @objc private func memoryWarning() { NativeRuntimeEvents.record("memory-warning") }
    private func showWebContentFailure() {
        let failure = UIView(frame: view.bounds)
        failure.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        failure.backgroundColor = .systemBackground
        let message = UILabel()
        message.text = "Jocki’s web process terminated.\n\nClose and reopen the app to inspect diagnostics. Automatic workspace reopening is paused."
        message.numberOfLines = 0
        message.font = .preferredFont(forTextStyle: .body)
        message.textColor = .label
        message.textAlignment = .center
        message.accessibilityIdentifier = "web-content-terminated"
        message.translatesAutoresizingMaskIntoConstraints = false
        failure.addSubview(message)
        NSLayoutConstraint.activate([
            message.leadingAnchor.constraint(equalTo: failure.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            message.trailingAnchor.constraint(equalTo: failure.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            message.centerYAnchor.constraint(equalTo: failure.safeAreaLayoutGuide.centerYAnchor)
        ])
        view.addSubview(failure)
    }
}

// Capacitor's native handler is visible to WKWebView subframes independently of
// injected JS globals. Opaque extension frames must never call it directly.
private class MainFrameBridge: NSObject, WKScriptMessageHandler {
    private let original: WKScriptMessageHandler
    init(_ original: WKScriptMessageHandler) { self.original = original; super.init() }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        original.userContentController(controller, didReceive: message)
    }
}

@objc(VaultFilesPlugin)
public class VaultFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "VaultFilesPlugin"
    public let jsName = "VaultFiles"
    public let pluginMethods: [CAPPluginMethod] = ["workspace", "select", "roots", "files"].compactMap { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private struct Root: Codable { var name: String; var bookmark: Data; var parentBookmark: Data? = nil }
    private struct Catalog: Codable { var computer: String; var roots: [String: Root] }
    private let io = DispatchQueue(label: "net.jocki.vault-files")
    private var catalog: Catalog?
    private var pickerCall: CAPPluginCall?
    private var pickerParentFor: String?
    private var base: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("JockiFiles", isDirectory: true) }
    private func durableWrite(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        let file = try FileHandle(forWritingTo: url)
        try file.synchronize(); try file.close()
        try syncParent(url)
    }
    private func syncParent(_ url: URL) throws {
        let directory = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY)
        guard directory >= 0 else { throw POSIXError(.EIO) }
        defer { Darwin.close(directory) }
        if Darwin.fsync(directory) != 0 { throw POSIXError(.EIO) }
    }
    private func loadCatalog() throws {
        if catalog != nil { return }
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let url = base.appendingPathComponent("capabilities.json")
        if FileManager.default.fileExists(atPath: url.path) { catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: url)) }
        else { catalog = Catalog(computer: UUID().uuidString, roots: [:]); try persistCatalog() }
    }
    private func persistCatalog() throws { try durableWrite(JSONEncoder().encode(catalog!), to: base.appendingPathComponent("capabilities.json")) }
    private func perform(_ call: CAPPluginCall, _ action: @escaping () throws -> JSObject) {
        io.async { do { try self.loadCatalog(); call.resolve(try action()) } catch { call.reject(error.localizedDescription) } }
    }
    @objc func workspace(_ call: CAPPluginCall) { perform(call) { [self] in ["computer": catalog!.computer, "sandboxedExtensions": true] } }
    @objc func roots(_ call: CAPPluginCall) { perform(call) { [self] in ["roots": catalog!.roots.map { ["token": $0.key, "name": $0.value.name] }] } }
    @objc func select(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pickerCall == nil else { call.reject("A folder picker is already open"); return }
            self.pickerCall = call
            self.pickerParentFor = call.getString("parentFor")
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self; picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { pickerCall?.resolve(["cancelled": true]); pickerCall = nil }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pickerCall, let url = urls.first else { return }; pickerCall = nil
        let parentFor = pickerParentFor; pickerParentFor = nil
        perform(call) { [self] in
            guard url.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
            defer { url.stopAccessingSecurityScopedResource() }
            let bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
            if let parentFor = parentFor, var saved = catalog!.roots[parentFor] {
                var stale = false
                let child = try URL(resolvingBookmarkData: saved.bookmark, options: .withoutUI, relativeTo: nil, bookmarkDataIsStale: &stale)
                guard child.deletingLastPathComponent().standardizedFileURL == url.standardizedFileURL else { throw CocoaError(.fileReadNoPermission) }
                saved.parentBookmark = bookmark; catalog!.roots[parentFor] = saved; try persistCatalog()
                return ["token": parentFor, "name": saved.name]
            }
            var token = UUID().uuidString
            for (key, saved) in catalog!.roots {
                var stale = false
                if let existing = try? URL(resolvingBookmarkData: saved.bookmark, options: .withoutUI, relativeTo: nil, bookmarkDataIsStale: &stale), existing.standardizedFileURL == url.standardizedFileURL { token = key; break }
            }
            catalog!.roots[token] = Root(name: url.lastPathComponent, bookmark: bookmark, parentBookmark: catalog!.roots[token]?.parentBookmark); try persistCatalog()
            return ["token": token, "name": url.lastPathComponent]
        }
    }
    private func withRoot<T>(_ token: String, companion: Bool = false, create: Bool = false, _ action: (URL) throws -> T) throws -> T {
        if token == "workspace" {
            let root = base.appendingPathComponent("workspace", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true); return try action(root)
        }
        guard let saved = catalog!.roots[token] else { throw CocoaError(.fileReadNoPermission) }
        var stale = false
        let root = try URL(resolvingBookmarkData: saved.bookmark, options: .withoutUI, relativeTo: nil, bookmarkDataIsStale: &stale)
        if companion {
            guard let bookmark = saved.parentBookmark else { throw CocoaError(.fileReadNoPermission) }
            var parentStale = false
            let parent = try URL(resolvingBookmarkData: bookmark, options: .withoutUI, relativeTo: nil, bookmarkDataIsStale: &parentStale)
            guard parent.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
            defer { parent.stopAccessingSecurityScopedResource() }
            guard root.deletingLastPathComponent().standardizedFileURL == parent.standardizedFileURL else { throw CocoaError(.fileReadNoPermission) }
            let package = parent.appendingPathComponent("." + root.lastPathComponent + ".saddle", isDirectory: false)
            if FileManager.default.fileExists(atPath: package.path) {
                guard try package.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw CocoaError(.fileReadNoPermission) }
            }
            return try action(package)
        }
        guard root.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
        defer { root.stopAccessingSecurityScopedResource() }
        if stale { catalog!.roots[token] = Root(name: saved.name, bookmark: try root.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil), parentBookmark: saved.parentBookmark); try persistCatalog() }
        return try action(root)
    }
    private func target(_ root: URL, _ path: String, create: Bool) throws -> URL {
        let parts = path.components(separatedBy: "/")
        guard !parts.isEmpty && !path.contains("\\") && !path.contains(":") && path.rangeOfCharacter(from: .controlCharacters) == nil && parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw CocoaError(.fileReadInvalidFileName) }
        var url = root
        for (index, part) in parts.enumerated() {
            url.appendPathComponent(part)
            if FileManager.default.fileExists(atPath: url.path) {
                if try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true { throw CocoaError(.fileReadNoPermission) }
            } else if create && index < parts.count - 1 { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) }
        }
        return url
    }
    private func coordinate<T>(_ url: URL, write: Bool, _ action: (URL) throws -> T) throws -> T {
        var error: NSError?, result: Result<T, Error>?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        if write { coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &error) { coordinated in result = Result { try action(coordinated) } } }
        else { coordinator.coordinate(readingItemAt: url, options: [], error: &error) { coordinated in result = Result { try action(coordinated) } } }
        if let error = error { throw error }; guard let result = result else { throw CocoaError(.fileReadUnknown) }; return try result.get()
    }
    private func entry(_ url: URL, path: String) throws -> JSObject {
        let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .fileSizeKey, .contentModificationDateKey, .creationDateKey])
        guard values.isSymbolicLink != true else { throw CocoaError(.fileReadNoPermission) }
        return ["path": path, "kind": url.lastPathComponent.hasSuffix(".saddle") ? "companion" : values.isDirectory == true ? "folder" : "file", "size": values.fileSize ?? 0, "stamp": "\(values.fileSize ?? 0):\(values.contentModificationDate?.timeIntervalSince1970 ?? 0):\(values.creationDate?.timeIntervalSince1970 ?? 0)"]
    }
    @objc func files(_ call: CAPPluginCall) {
        perform(call) { [self] in
            guard let token = call.getString("token"), let requested = call.getString("operation") else { throw CocoaError(.fileReadInvalidFileName) }
            if requested == "root-access" { return ["value": catalog!.roots[token]?.parentBookmark != nil] }
            let companion = requested.hasPrefix("root-") || requested == "delete-root-companion"
            let operation = requested.hasPrefix("root-") ? String(requested.dropFirst(5)) : requested
            if companion && catalog!.roots[token]?.parentBookmark == nil {
                if operation == "read" || operation == "read-range" { return ["data": NSNull()] }
                if operation == "scan" { return ["value": []] }
                throw CocoaError(.fileReadNoPermission)
            }
            return try withRoot(token, companion: companion, create: operation == "write" || operation == "mkdir") { root in
                if requested == "delete-root-companion" { if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root); try syncParent(root) }; return [:] }
                if operation == "scan" {
                    let prefix = (call.getString("path") ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    let directory = prefix.isEmpty ? root : try target(root, prefix, create: false)
                    if !FileManager.default.fileExists(atPath: directory.path) { return ["value": []] }
                    guard let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey, .isDirectoryKey]) else { throw CocoaError(.fileReadUnknown) }
                    var entries: [JSObject] = []
                    for case let url as URL in files {
                        let name = url.lastPathComponent, values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
                        if values.isSymbolicLink == true || name == ".git" || name == ".saddle" || name.hasPrefix(".jocki-write-") { files.skipDescendants(); continue }
                        let path = String(url.path.dropFirst(root.path.count + 1)); entries.append(try entry(url, path: path))
                        if name.hasSuffix(".saddle") { files.skipDescendants() }
                    }
                    return ["value": entries]
                }
                if operation == "stat" {
                    guard let path = call.getString("path") else { throw CocoaError(.fileReadInvalidFileName) }
                    let url = companion ? root : try target(root, path, create: false)
                    if companion && path != "container" { throw CocoaError(.fileReadNoPermission) }
                    return ["value": FileManager.default.fileExists(atPath: url.path) ? try entry(url, path: path) : NSNull()]
                }
                if operation == "move" {
                    guard let path = call.getString("path"), let encoded = call.getString("data"), let data = Data(base64Encoded: encoded), let destination = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadInvalidFileName) }
                    let source = try target(root, path, create: false), target = try target(root, destination, create: true)
                    guard !FileManager.default.fileExists(atPath: target.path) else { throw CocoaError(.fileWriteFileExists) }
                    try FileManager.default.moveItem(at: source, to: target); try syncParent(source); try syncParent(target); return [:]
                }
                if operation == "list" || operation == "directories" {
                    return try coordinate(root, write: false) { root in
                        var paths: [String] = []
                        let keys: [URLResourceKey] = [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey]
                        guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else { throw CocoaError(.fileReadUnknown) }
                        for case let url as URL in files {
                            let relative = String(url.path.dropFirst(root.path.count + 1)), values = try url.resourceValues(forKeys: Set(keys))
                            if values.isSymbolicLink == true || url.lastPathComponent.lowercased() == ".saddle" || url.lastPathComponent.hasPrefix(".jocki-write-") { files.skipDescendants(); continue }
                            if url.lastPathComponent.hasSuffix(".saddle") { if operation == "list" { paths.append(relative) }; files.skipDescendants(); continue }
                            if (operation == "directories" && values.isDirectory == true) || (operation == "list" && values.isRegularFile == true) { paths.append(relative) }
                        }
                        return ["paths": paths.sorted()]
                    }
                }
                guard let path = call.getString("path") else { throw CocoaError(.fileReadInvalidFileName) }
                if companion && (path != "container" || !["read", "read-range", "write-at", "write", "remove"].contains(operation)) { throw CocoaError(.fileReadNoPermission) }
                let url = companion ? root : try target(root, path, create: operation == "write" || operation == "mkdir")
                if operation == "mkdir" {
                    return try coordinate(url, write: true) { try FileManager.default.createDirectory(at: $0, withIntermediateDirectories: true); try syncParent($0); return [:] }
                }
                if operation == "reset" {
                    guard url.lastPathComponent.hasSuffix(".saddle") else { throw CocoaError(.fileWriteInvalidFileName) }
                    if FileManager.default.fileExists(atPath: url.path) { try coordinate(url, write: true) { try FileManager.default.removeItem(at: $0); try syncParent($0) } }
                    return [:]
                }
                if operation == "rmdir" {
                    guard try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw CocoaError(.fileWriteInvalidFileName) }
                    return try coordinate(url, write: true) { directory in
                        if let entries = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
                            for case let child as URL in entries { let values = try child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]); if values.isDirectory != true || values.isSymbolicLink == true { throw CocoaError(.fileWriteFileExists) } }
                        }
                        try FileManager.default.removeItem(at: directory); try syncParent(directory); return [:]
                    }
                }
                if operation == "read-range" {
                    if !FileManager.default.fileExists(atPath: url.path) { return ["data": NSNull()] }
                    guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded), let range = try JSONSerialization.jsonObject(with: data) as? [Int], range.count == 2, range[0] >= 0, range[1] >= 0, range[1] <= 1024 * 1024 else { throw CocoaError(.fileReadInvalidFileName) }
                    return try coordinate(url, write: false) { target in
                        let file = try FileHandle(forReadingFrom: target); defer { try? file.close() }
                        try file.seek(toOffset: UInt64(range[0])); return ["data": (try file.read(upToCount: range[1]) ?? Data()).base64EncodedString()]
                    }
                }
                if operation == "write-at" {
                    guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded), data.count >= 8 else { throw CocoaError(.fileReadCorruptFile) }
                    let offset = data.prefix(8).enumerated().reduce(UInt64(0)) { $0 | UInt64($1.element) << (8 * $1.offset) }
                    return try coordinate(url, write: true) { target in
                        let file = try FileHandle(forUpdating: target); defer { try? file.close() }
                        try file.seek(toOffset: offset); try file.write(contentsOf: data.dropFirst(8)); try file.synchronize(); return [:]
                    }
                }
                if operation == "read" {
                    if !FileManager.default.fileExists(atPath: url.path) { return ["data": NSNull()] }
                    return try coordinate(url, write: false) { ["data": try Data(contentsOf: $0).base64EncodedString()] }
                }
                if operation == "write" {
                    guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded) else { throw CocoaError(.fileReadCorruptFile) }
                    return try coordinate(url, write: true) { try durableWrite(data, to: $0); return [:] }
                }
                if operation == "remove" {
                    if FileManager.default.fileExists(atPath: url.path) { try coordinate(url, write: true) { try FileManager.default.removeItem(at: $0); try syncParent($0) } }
                    return [:]
                }
                throw CocoaError(.fileReadInvalidFileName)
            }
        }
    }
}

// Keep termination evidence outside the WebView: its JS heap and console vanish
// when iOS terminates WebContent. No workspace contents or credentials are logged.
private enum NativeRuntimeEvents {
    static let key = "jocki.runtime-events"
    static func record(_ type: String) {
        var events = UserDefaults.standard.array(forKey: key) as? [[String: String]] ?? []
        events.append(["type": type, "at": ISO8601DateFormatter().string(from: Date())])
        UserDefaults.standard.set(Array(events.suffix(8)), forKey: key)
        NSLog("Jocki runtime: %@", type)
    }
}

// Forward navigation to Capacitor, but leave process termination visible instead
// of invoking its automatic reload/reset. The view controller retains this proxy.
private class RuntimeNavigationDiagnostics: NSObject, WKNavigationDelegate {
    private weak var original: WKNavigationDelegate?
    private let terminated: () -> Void
    init(_ original: WKNavigationDelegate, terminated: @escaping () -> Void) {
        self.original = original
        self.terminated = terminated
        super.init()
    }
    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (original?.responds(to: selector) ?? false)
    }
    override func forwardingTarget(for selector: Selector!) -> Any? {
        if original?.responds(to: selector) == true { return original }
        return super.forwardingTarget(for: selector)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NativeRuntimeEvents.record("web-content-terminated")
        terminated()
    }
}

@objc(RuntimeDiagnosticsPlugin)
public class RuntimeDiagnosticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RuntimeDiagnosticsPlugin"
    public let jsName = "RuntimeDiagnostics"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "consume", returnType: CAPPluginReturnPromise)]
    @objc func consume(_ call: CAPPluginCall) {
        let events = UserDefaults.standard.array(forKey: NativeRuntimeEvents.key) ?? []
        UserDefaults.standard.removeObject(forKey: NativeRuntimeEvents.key)
        call.resolve(["events": events])
    }
}
