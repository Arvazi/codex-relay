import AppKit

private let repoPath = "/Users/arianvaziri/Projects/codex-relay"
// Keep in sync with defaultCodexRelayPort in packages/codex-relay/src/api-schema.ts.
private let relayPort = 8790
private let healthURL = URL(string: "http://127.0.0.1:\(relayPort)/version")!

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private var statusLabel: NSTextField!
  private var detailLabel: NSTextField!
  private var actionButton: NSButton!
  private var relayProcess: Process?
  private var metroProcess: Process?
  private var nextMetroCheck = Date.distantPast
  private var ownsRelay = false
  private var sleepActivity: NSObjectProtocol?
  private var timer: Timer?
  private var isRunning = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildWindow()
    timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      self?.refresh()
    }
    refresh { [weak self] running in
      if !running {
        self?.startRelay()
      }
    }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag {
      window.makeKeyAndOrderFront(nil)
    }
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    if ownsRelay {
      stopRelay()
    }
    allowSleep()
  }

  private func buildWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 280),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Codex Relay"
    window.isReleasedWhenClosed = false
    window.center()

    let content = NSView(frame: window.contentView!.bounds)
    content.autoresizingMask = [.width, .height]
    window.contentView = content

    statusLabel = NSTextField(labelWithString: "Checking…")
    statusLabel.font = .systemFont(ofSize: 22, weight: .semibold)
    statusLabel.frame = NSRect(x: 24, y: 210, width: 372, height: 30)

    detailLabel = NSTextField(wrappingLabelWithString: "The Mac stays awake while the relay is running.")
    detailLabel.font = .systemFont(ofSize: 13)
    detailLabel.textColor = .secondaryLabelColor
    detailLabel.frame = NSRect(x: 24, y: 78, width: 372, height: 120)

    actionButton = NSButton(title: "Start", target: self, action: #selector(toggleRelay))
    actionButton.bezelStyle = .rounded
    actionButton.controlSize = .large
    actionButton.frame = NSRect(x: 24, y: 24, width: 120, height: 32)

    content.addSubview(statusLabel)
    content.addSubview(detailLabel)
    content.addSubview(actionButton)
  }

  @objc private func toggleRelay() {
    if isRunning {
      stopRelay()
    } else {
      startRelay()
    }
  }

  private func startRelay() {
    guard relayProcess == nil else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = [
      "-c",
      """
      cd \(shellQuote(repoPath))
      export PATH="/opt/homebrew/bin:/usr/bin:/bin"
      export TAILSCALE_SOCKET="/tmp/tailscaled-silkrock.sock"
      exec /usr/bin/caffeinate -i /opt/homebrew/bin/pnpm dev
      """,
    ]
    process.currentDirectoryURL = URL(fileURLWithPath: repoPath)
    let logURL = logFileURL()
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    if let handle = try? FileHandle(forWritingTo: logURL) {
      handle.seekToEndOfFile()
      process.standardOutput = handle
      process.standardError = handle
    }
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.relayProcess = nil
        self?.ownsRelay = false
        self?.refresh()
      }
    }
    do {
      try process.run()
      relayProcess = process
      ownsRelay = true
      statusLabel.stringValue = "Starting…"
      detailLabel.stringValue = "Starting the relay. The Mac stays awake once it is up."
      actionButton.title = "Stop"
      actionButton.isEnabled = true
    } catch {
      statusLabel.stringValue = "Could not start"
      detailLabel.stringValue = error.localizedDescription
    }
  }

  private func stopRelay() {
    if let process = relayProcess, process.isRunning {
      terminateProcessTree(process.processIdentifier)
    } else if let pid = listenerPID() {
      terminateProcessTree(pid)
    }
    relayProcess = nil
    ownsRelay = false
    allowSleep()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
      self?.refresh()
    }
  }

  private func refresh(completion: ((Bool) -> Void)? = nil) {
    var request = URLRequest(url: healthURL)
    request.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let ok = (response as? HTTPURLResponse)?.statusCode == 200
        && (data?.isEmpty == false)
      DispatchQueue.main.async {
        self.apply(running: ok)
        completion?(ok)
      }
    }.resume()
  }

  private func apply(running: Bool) {
    isRunning = running
    if running {
      preventSleep()
      statusLabel.stringValue = "Running"
      detailLabel.stringValue = tailscaleDetail(
        "Phone can reach this Mac from any network while Tailscale is connected on both. The Mac will not idle-sleep until you stop the relay.",
      )
      ensureMetro()
      actionButton.title = "Stop"
    } else {
      allowSleep()
      if relayProcess != nil {
        statusLabel.stringValue = "Starting…"
        detailLabel.stringValue = "Waiting for the relay to come up."
      } else {
        statusLabel.stringValue = "Stopped"
        detailLabel.stringValue = "Start the relay to pair the phone. The Mac can sleep while it is stopped."
      }
      actionButton.title = "Start"
    }
    actionButton.isEnabled = true
  }

  private func preventSleep() {
    guard sleepActivity == nil else { return }
    sleepActivity = ProcessInfo.processInfo.beginActivity(
      options: [.idleSystemSleepDisabled, .suddenTerminationDisabled],
      reason: "Codex Relay is running"
    )
  }

  private func allowSleep() {
    if let sleepActivity {
      ProcessInfo.processInfo.endActivity(sleepActivity)
      self.sleepActivity = nil
    }
  }

  private func ensureMetro() {
    if let process = metroProcess, process.isRunning {
      return
    }
    metroProcess = nil
    guard Date() >= nextMetroCheck else { return }
    nextMetroCheck = Date().addingTimeInterval(30)
    guard listenerPID(port: 8081) == nil else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = [
      "-c",
      """
      cd \(shellQuote(repoPath))/apps/mobile
      export PATH="/opt/homebrew/bin:/usr/bin:/bin"
      exec /opt/homebrew/bin/pnpm exec expo start --dev-client --port 8081 --host lan
      """,
    ]
    process.currentDirectoryURL = URL(fileURLWithPath: repoPath + "/apps/mobile")
    let logURL = logFileURL().deletingLastPathComponent().appendingPathComponent("metro.log")
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    if let handle = try? FileHandle(forWritingTo: logURL) {
      handle.seekToEndOfFile()
      process.standardOutput = handle
      process.standardError = handle
    }
    process.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.metroProcess = nil
      }
    }
    try? process.run()
    metroProcess = process
  }

  private func listenerPID(port: Int = relayPort) -> pid_t? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    process.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return nil
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let text = String(data: data, encoding: .utf8)?
      .split(whereSeparator: \.isNewline)
      .first,
      let pid = Int32(text)
    else {
      return nil
    }
    return pid
  }

  private func terminateProcessTree(_ pid: pid_t) {
    let killer = Process()
    killer.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
    killer.arguments = ["-TERM", "-P", String(pid)]
    try? killer.run()
    killer.waitUntilExit()
    kill(pid, SIGTERM)
  }

  private func logFileURL() -> URL {
    let directory = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Logs/Codex Relay", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("relay.log")
  }

  private func tailscaleDetail(_ fallback: String) -> String {
    guard let url = tailscaleUrl() else { return fallback }
    return "Tailscale\n\(url)\n\n\(fallback)"
  }

  private func tailscaleUrl() -> String? {
    let url = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/codex-relay/server-state.json")
    guard let data = try? Data(contentsOf: url),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return nil
    }
    let candidates = json["connectUrlCandidates"] as? [[String: Any]] ?? []
    let urls = candidates.compactMap { $0["url"] as? String }
    if let connect = json["connectUrl"] as? String {
      return ([connect] + urls).first(where: isTailscaleUrl(_:))
    }
    return urls.first(where: isTailscaleUrl(_:))
  }

  private func isTailscaleUrl(_ value: String) -> Bool {
    guard let host = URL(string: value)?.host?.lowercased() else { return false }
    if host.hasSuffix(".ts.net") || host.hasSuffix(".beta.tailscale.net") {
      return true
    }
    let parts = host.split(separator: ".").compactMap { Int($0) }
    guard parts.count == 4, let first = parts.first, let second = parts.dropFirst().first else {
      return false
    }
    return first == 100 && second >= 64 && second <= 127
  }

  private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
