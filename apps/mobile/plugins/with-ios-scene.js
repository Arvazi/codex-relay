const { withAppDelegate, withInfoPlist } = require("@expo/config-plugins");

const legacyWindowStartup = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`;

const sceneWindowStartup = `storedLaunchOptions = launchOptions

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    configuration.delegateClass = CodexRelaySceneDelegate.self
    return configuration`;

const sceneDelegate = `class CodexRelaySceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: mergedLaunchOptions(
        stored: appDelegate.storedLaunchOptions,
        connectionOptions: connectionOptions
      )
    )
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else {
      return
    }
    _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity) { _ in }
  }
}

private func mergedLaunchOptions(
  stored: [UIApplication.LaunchOptionsKey: Any]?,
  connectionOptions: UIScene.ConnectionOptions
) -> [UIApplication.LaunchOptionsKey: Any]? {
  var options = stored ?? [:]
  if let url = connectionOptions.urlContexts.first?.url {
    options[.url] = url
  }
  if let userActivity = connectionOptions.userActivities.first {
    options[.userActivityDictionary] = [
      "UIApplicationLaunchOptionsUserActivityTypeKey": userActivity.activityType,
      "UIApplicationLaunchOptionsUserActivityKey": userActivity,
    ]
  }
  return options.isEmpty ? nil : options
}

`;

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "CodexRelay.CodexRelaySceneDelegate",
          },
        ],
      },
    };
    return config;
  });

  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") {
      return config;
    }

    let contents = config.modResults.contents;
    if (!contents.includes("var storedLaunchOptions")) {
      contents = contents.replace(
        "var reactNativeFactory: RCTReactNativeFactory?",
        "var reactNativeFactory: RCTReactNativeFactory?\n  var storedLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?",
      );
    }
    if (contents.includes(legacyWindowStartup)) {
      contents = contents.replace(legacyWindowStartup, sceneWindowStartup);
    }
    if (!contents.includes("class CodexRelaySceneDelegate")) {
      contents = contents.replace(
        "class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {",
        `${sceneDelegate}class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {`,
      );
    }
    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withIosSceneLifecycle;
