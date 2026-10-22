//
//  OverlayPanel.swift
//  ZCode TPS 悬浮面板(macOS 置顶常驻悬浮窗)
//
//  说明:
//  - 纯 AppKit + WebKit(WKWebView)实现,不依赖 SwiftUI / Xcode 工程;
//  - 由同目录 build-macos.sh 用 swiftc 直接编译,兼容 Swift 6(-swift-version 6);
//  - 置顶常驻:无边框 NSPanel + .floating 层级 + 跨所有空间,点击不激活本应用;
//  - 内嵌 WKWebView 加载悬浮窗服务页面,默认 http://127.0.0.1:17873/,
//    可用第一个命令行参数覆盖,例如:OverlayPanel http://127.0.0.1:9999/。
//  - 可选参数:--size 宽x高(如 --size 620x40,配合页面 ?style=line 单行模式)、
//    --pos x,y(Cocoa 坐标,屏幕左下为原点);缺省为卡片尺寸、主屏右上角。
//

import AppKit
import WebKit

// MARK: - 默认配置

/// 悬浮窗服务默认地址(与悬浮窗服务的 URL 契约一致)
let defaultOverlayURLString = "http://127.0.0.1:17873/"

/// 面板内容尺寸(约 330×184,含速率曲线空间)
let panelContentSize = NSSize(width: 330, height: 184)

/// 右侧按钮交互区宽度:透明拖动层不覆盖这一段,页面把交互按钮放这里
/// (页面 .ctrls 与此契约对齐:右上角 / 单行模式右端)
let controlZoneWidth: CGFloat = 120

/// 页面加载失败后的自动重试间隔(秒)——服务可能尚未就绪或瞬时不可达
let reloadRetryInterval: TimeInterval = 3

// MARK: - 悬浮面板

/// 透明拖动层:覆盖面板左侧区域(右侧留 controlZoneWidth 给页面按钮),负责把按住
/// 拖动手势交给窗口。
///
/// 为什么需要它:`isMovableByWindowBackground = true` 只对命中视图
/// `mouseDownCanMoveWindow == true` 的区域生效,而铺满面板的 WKWebView 该属性为
/// false(本机编译探针实测),原生路径下按住页面任何位置都拖不动窗口——面板只能停在
/// 初始位置。此层显式放行该属性,并在 `mouseDown` 里调 `performDrag(with:)`
/// 双保险:任一路径都能拖动整个面板。
///
/// 右侧不覆盖:页面在右上角(单行模式为右端)放置交互按钮(刷新/暂停/曲线),
/// 这一段的点击事件直达 WKWebView,由页面自行处理。
final class PanelDragView: NSView {

    /// 放行 isMovableByWindowBackground 的原生拖动路径
    override var mouseDownCanMoveWindow: Bool { true }

    /// 自行把手势交给窗口:边框面板拖动即移动,无需跟踪鼠标轨迹
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

/// 置顶悬浮面板:无边框、透明背景、可拖动、不激活应用(nonactivating)、跨所有空间常驻
final class OverlayPanel: NSPanel, WKNavigationDelegate {

    /// 目标页面地址
    private let overlayURL: URL

    /// 内容尺寸(单行模式可经 --size 缩为细横条)
    private let contentSize: NSSize

    /// 内嵌的浏览器视图
    private let webView: WKWebView

    init(url: URL, contentSize: NSSize) {
        self.overlayURL = url
        self.contentSize = contentSize

        // WKWebView:默认配置即可加载本地回环地址的页面
        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: NSRect(origin: .zero, size: contentSize),
                                configuration: configuration)
        // 透明背景:窗口与页面全透明,外观(圆角卡片、阴影等)由 HTML 页面自行决定
        // (macOS 12+:WKWebView 通过 underPageBackgroundColor 控制页面底色)
        webView.underPageBackgroundColor = .clear
        self.webView = webView

        // .nonactivatingPanel:点击/操作面板不会激活本应用,不抢键盘焦点
        super.init(contentRect: NSRect(origin: .zero, size: contentSize),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)

        // 置顶悬浮:浮动层级(在普通窗口之上)
        level = .floating
        // 跨空间常驻:所有桌面空间/全屏空间均可见,且不随空间切换移动
        collectionBehavior = [.canJoinAllSpaces, .stationary]

        // 窗口背景完全透明(本 SDK 中 NSWindow.isOpaque 可直接赋值)
        isOpaque = false
        backgroundColor = .clear
        // 页面通常自带阴影样式,关闭窗口阴影以免叠加
        hasShadow = false

        // 按住面板任意位置即可拖动:由 WebView 之上的透明拖动层(PanelDragView)承接。
        // 注意 contentView 直接设为 webView 时该开关不生效——WKWebView 的
        // mouseDownCanMoveWindow 为 false,原生背景拖动路径被它挡住(见 PanelDragView 注释)。
        isMovableByWindowBackground = true

        // 应用失活时不隐藏,保证常驻显示
        hidesOnDeactivate = false

        // 内容层级:容器 = WKWebView(铺满)+ 透明拖动层(覆盖左侧,右侧留 controlZoneWidth
        // 给页面的交互按钮区)。拖动层放行鼠标按下并转交窗口:按住左侧任意位置即可移动,
        // 右侧按钮区的点击直达 WKWebView。
        let container = NSView(frame: NSRect(origin: .zero, size: contentSize))
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
        let dragView = PanelDragView(frame: NSRect(origin: .zero,
                                                  size: NSSize(width: max(0, contentSize.width - controlZoneWidth),
                                                               height: contentSize.height)))
        dragView.autoresizingMask = [.width, .height]
        container.addSubview(dragView)
        contentView = container

        webView.navigationDelegate = self
        load()
    }

    /// 加载悬浮窗服务页面
    func load() {
        webView.load(URLRequest(url: overlayURL))
    }

    /// 加载失败后延时自动重试(服务可能尚未启动)
    private func scheduleReload() {
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(reloadRetryInterval * 1_000_000_000))
            self?.load()
        }
    }

    // MARK: WKNavigationDelegate(仅用于失败自动重试)

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[OverlayPanel] 页面加载失败(%@),%.0f 秒后重试", error.localizedDescription, reloadRetryInterval)
        scheduleReload()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // 服务未启动 / 连接被拒时走这里
        NSLog("[OverlayPanel] 无法连接服务(%@),%.0f 秒后重试", error.localizedDescription, reloadRetryInterval)
        scheduleReload()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // WebContent 进程退出后自动恢复加载
        NSLog("[OverlayPanel] WebContent 进程退出,自动重新加载")
        load()
    }
}

// MARK: - 应用委托

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    /// 持有面板,防止被释放
    private var panel: OverlayPanel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 命令行第一个参数为目标页面 URL(可选),默认 http://127.0.0.1:17873/
        let arguments = Array(CommandLine.arguments.dropFirst())
        // 第一个非 --size/--pos 参数为页面 URL;--size 宽x高;--pos x,y(Cocoa 坐标)
        var urlString: String?
        var size = panelContentSize
        var origin: NSPoint?
        var idx = 0
        while idx < arguments.count {
            let arg = arguments[idx]
            if arg == "--size", idx + 1 < arguments.count {
                let parts = arguments[idx + 1].split(separator: "x").compactMap { Double($0) }
                if parts.count == 2 { size = NSSize(width: parts[0], height: parts[1]) }
                idx += 2
            } else if arg == "--pos", idx + 1 < arguments.count {
                let parts = arguments[idx + 1].split(separator: ",").compactMap { Double($0) }
                if parts.count == 2 { origin = NSPoint(x: parts[0], y: parts[1]) }
                idx += 2
            } else {
                if urlString == nil { urlString = arg }
                idx += 1
            }
        }

        guard let url = URL(string: urlString ?? defaultOverlayURLString), url.scheme != nil, url.host != nil else {
            FileHandle.standardError.write(Data("[OverlayPanel] 无效 URL:\(urlString ?? "(nil)")\n".utf8))
            NSApplication.shared.terminate(self)
            return
        }

        let panel = OverlayPanel(url: url, contentSize: size)

        // 初始位置:--pos 指定;缺省为主屏幕可视区域右上角,四周留 16pt 边距
        if let origin {
            panel.setFrameOrigin(origin)
        } else if let visibleFrame = NSScreen.main?.visibleFrame {
            let x = visibleFrame.maxX - size.width - 16
            let y = visibleFrame.maxY - size.height - 16
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        // 非激活方式直接置前显示(不抢焦点)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    /// 面板关闭后随之退出进程,避免残留无窗口的后台进程
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

// MARK: - 程序入口

@main
enum OverlayPanelApp {

    @MainActor
    static func main() {
        let app = NSApplication.shared
        // 附件型应用:无 Dock 图标、无菜单栏。
        // 与 Info.plist 中的 LSUIElement=true 双保险:即使绕过 .app 直接执行裸二进制也生效。
        app.setActivationPolicy(.accessory)

        let delegate = AppDelegate()
        app.delegate = delegate

        app.run()
    }
}
