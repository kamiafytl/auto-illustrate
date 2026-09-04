from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

from PySide6.QtCore import QLockFile, Qt, QTimer, Signal
from PySide6.QtGui import QFont, QFontDatabase, QPixmap
from PySide6.QtWidgets import (QApplication, QDialog, QFormLayout, QHBoxLayout,
                               QVBoxLayout, QWidget)
from qfluentwidgets import (BodyLabel, FluentIcon, FluentWindow, MessageBox,
                            NavigationItemPosition, PasswordLineEdit,
                            PrimaryPushButton, PushButton, ScrollArea, SmoothMode,
                            Theme, qconfig, setTheme)

from nai_terminal import vault
from nai_terminal.gui.background import BackgroundExecutor
from nai_terminal.gui.console_page import ConsolePage
from nai_terminal.gui_store import ConfigStore, PrivateStore, QueueClient, TerminalConfig


def apply_theme(value: str):
    try:
        setTheme({"light": Theme.LIGHT, "dark": Theme.DARK}.get(value, Theme.AUTO),
                 save=False, lazy=True)
    except Exception:
        logging.exception("主题切换失败")


def apply_readable_font(app: QApplication) -> None:
    """Prefer a Chinese UI font and keep body text at a readable 15 px."""
    available = set(QFontDatabase.families())
    # Qt's Windows offscreen plugin reports an empty system font database.  The
    # smoke renderer still needs a real CJK font so screenshots remain reviewable.
    if not available and os.name == "nt":
        for path in (Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "msyh.ttc",
                     Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "simhei.ttf"):
            if path.is_file():
                QFontDatabase.addApplicationFont(str(path))
        available = set(QFontDatabase.families())
    family = next((name for name in (
        "Microsoft YaHei UI", "Microsoft YaHei", "微软雅黑",
        "Noto Sans CJK SC", "Source Han Sans SC", "SimHei") if name in available), "")
    font = QFont(family) if family else app.font()
    font.setPixelSize(15)
    app.setFont(font)


def disable_smooth_scrolling(root: QWidget) -> None:
    """Keep wheel input immediate, matching the old web editor.

    qfluentwidgets enables an animated, queued wheel effect for every
    ``ScrollArea`` by default.  That feels like input lag in a long form and can
    continue moving after the user has stopped scrolling.  The terminal does
    not need that decoration, so all page scroll areas use Qt's direct wheel
    handling instead.
    """
    areas = []
    if isinstance(root, ScrollArea):
        areas.append(root)
    areas.extend(root.findChildren(ScrollArea))
    for area in areas:
        area.setSmoothMode(SmoothMode.NO_SMOOTH, Qt.Orientation.Vertical)
        area.setSmoothMode(SmoothMode.NO_SMOOTH, Qt.Orientation.Horizontal)


class SafeApplication(QApplication):
    """Keep exceptions from escaping Qt callbacks and report them visibly."""

    callbackError = Signal(str)

    def notify(self, receiver, event):
        try:
            return super().notify(receiver, event)
        except Exception:
            logging.exception("UI 回调失败")
            self.callbackError.emit("操作失败；详情已写入 gui.log")
            return False


class PasswordDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("解锁 vault")
        form = QFormLayout(self)
        form.addRow(BodyLabel("请输入 vault 密码。密码仅用于本机解锁。"))
        self.password = PasswordLineEdit()
        form.addRow(BodyLabel("密码："), self.password)
        buttons = QHBoxLayout()
        buttons.addStretch(1)
        cancel = PushButton("取消")
        okay = PrimaryPushButton("解锁")
        cancel.clicked.connect(self.reject)
        okay.clicked.connect(self.accept)
        buttons.addWidget(cancel)
        buttons.addWidget(okay)
        form.addRow(buttons)


class LazyPage(QWidget):
    """Build a secondary page on first visit, after the launcher is visible."""

    def __init__(self, object_name: str, factory, parent=None):
        super().__init__(parent)
        self.setObjectName(object_name)
        self.factory = factory
        self.content = None
        self.building = False
        self.layout = QVBoxLayout(self)
        self.layout.setContentsMargins(0, 0, 0, 0)
        self.loading = BodyLabel("正在载入…")
        self.layout.addWidget(self.loading)

    def showEvent(self, event):
        super().showEvent(event)
        if self.content is None and not self.building:
            self.building = True
            QTimer.singleShot(0, self._build)

    def _build(self):
        try:
            self.content = self.factory()
            self.layout.removeWidget(self.loading)
            self.loading.deleteLater()
            self.layout.addWidget(self.content)
            disable_smooth_scrolling(self.content)
        except Exception:
            logging.exception("延迟页面加载失败")
            self.loading.setText("页面加载失败；详情见 gui.log")
        finally:
            self.building = False

    @property
    def autosave(self):
        return getattr(self.content, "autosave", None)

    def shutdown(self):
        callback = getattr(self.content, "shutdown", None)
        if callback:
            callback()


class TerminalWindow(FluentWindow):
    def __init__(self, root: Path, smoke=False):
        super().__init__()
        self.setWindowTitle("NAI 出图终端")
        # A near-square working window mirrors the proportions of the ComfyUI
        # launcher and leaves enough room for a two-column preset editor.
        self.resize(1000, 850)
        self.setMinimumSize(760, 640)
        self.executor = BackgroundExecutor(self)
        config = ConfigStore(root)
        private = PrivateStore(root)
        available = True
        if private.vault_mode:
            try:
                cached = private.unlock_cached()
            except Exception:
                cached = False
            if not cached:
                dialog = PasswordDialog(self)
                if dialog.exec() != QDialog.DialogCode.Accepted:
                    available = False
                else:
                    try:
                        private.unlock(dialog.password.text())
                        try:
                            private.cache_unlocked()
                        except Exception:
                            MessageBox("缓存失败", "本次已经解锁，但下次启动仍需输入密码。", self).exec()
                    except vault.VaultAuthError:
                        available = False
                        MessageBox("解锁失败", "密码错误，vault 未解锁。", self).exec()
                    except Exception:
                        available = False
                        MessageBox("解锁失败", "vault 无法解锁。", self).exec()
                    finally:
                        dialog.password.clear()
        if available:
            try:
                # One-time privacy migration for historical public fileName
                # fields.  It is a no-op after the first successful launch.
                private.migrate_reference_metadata(config)
            except Exception:
                logging.exception("角色参考元数据迁移失败")
        queue_client = QueueClient(root)
        self.console_page = ConsolePage(queue_client, self.executor, root=root, smoke=smoke)
        disable_smooth_scrolling(self.console_page)

        def make_global_page():
            from nai_terminal.gui.global_page import GlobalPage
            return GlobalPage(config, private, self.executor, available)

        def make_preset_page():
            from nai_terminal.gui.preset_page import PresetPage
            return PresetPage(config, private, self.executor, available)

        def make_queue_page():
            from nai_terminal.gui.queue_page import QueuePage
            return QueuePage(queue_client, smoke=smoke)

        def make_options_page():
            from nai_terminal.gui.options_page import OptionsPage
            return OptionsPage(config, TerminalConfig(root), self.executor, apply_theme)

        self.global_page = LazyPage("globalLazyPage", make_global_page)
        self.preset_page = LazyPage("presetLazyPage", make_preset_page)
        self.queue_page = LazyPage("queueLazyPage", make_queue_page)
        self.options_page = LazyPage("optionsLazyPage", make_options_page)
        self.pages = [self.console_page, self.global_page, self.preset_page,
                      self.queue_page, self.options_page]
        for page, icon, label in (
                (self.console_page, FluentIcon.COMMAND_PROMPT, "终端后台"),
                (self.global_page, FluentIcon.HOME, "全局"),
                (self.preset_page, FluentIcon.EDIT, "单独预设"),
                (self.queue_page, FluentIcon.HISTORY, "队列")):
            self.addSubInterface(page, icon, label)
        self.addSubInterface(self.options_page, FluentIcon.SETTING, "设置",
                             NavigationItemPosition.BOTTOM)
        # MSFluentWindow 在当前 Windows/PySide6 组合中会触发 native access
        # violation，窗口来不及执行 closeEvent 时会留下孤儿 worker。稳定版
        # FluentWindow 保持 48px 窄导航，同时让后台生命周期真正受窗口控制。
        nav = self.navigationInterface
        nav.setCollapsible(False)
        nav.setReturnButtonVisible(False)
        self.switchTo(self.console_page)

    def closeEvent(self, event):
        if self.console_page.has_owned_services():
            box = MessageBox(
                "退出 NAI 出图终端",
                "面板启动的服务仍在运行。是否安全停止服务后退出？",
                self)
            box.yesButton.setText("停止并退出")
            box.cancelButton.setText("取消")
            if not box.exec():
                event.ignore()
                return
            if not self.console_page.stop_managed_and_wait():
                MessageBox("无法退出", "服务没有安全停止。窗口将保持打开，请查看控制台日志。", self).exec()
                event.ignore()
                return
        for page in self.pages:
            autosave = getattr(page, "autosave", None)
            if autosave:
                try:
                    autosave.flush()
                except Exception:
                    logging.exception("关闭前自动保存失败")
        for page in self.pages:
            shutdown = getattr(page, "shutdown", None)
            if shutdown:
                try:
                    shutdown()
                except Exception:
                    logging.exception("页面停止失败")
        self.executor.shutdown()
        super().closeEvent(event)

    def show_callback_error(self, message):
        self.statusBar().showMessage(message, 8000)


def _write_smoke_fixture(root: Path):
    data = root / "data"
    data.mkdir(parents=True)
    cfg = {
        "output_folder": "output/fixture", "global_layer": {"enabled": True, "rules": [
            {"id": "fixture-delete", "kind": "delete", "scope": "all", "enabled": True},
            {"id": "fixture-replace", "kind": "replace", "scope": "positive", "enabled": True}]},
        "augmentation_presets": {"activeId": "fixture-preset", "presets": [{
            "id": "fixture-preset", "name": "默认", "group": "常用", "enabled": True,
            "base_positive": {"text": "", "enabled": True, "isPrivate": True,
                              "position": "prefix", "role": "main"},
            "base_negative": {"text": "", "enabled": True, "isPrivate": True,
                              "position": "prefix", "role": "f2"},
            "chars": [{"id": "fixture-char", "name": "假角色", "text": "", "front_text": "",
                       "negative": "", "enabled": True, "isPrivate": True,
                       "position": "prefix", "role": "f1", "x": 0.5, "y": 0.5,
                       "char_index": 1, "extras": [{"id": "fixture-char-extra",
                           "kind": "positive", "text": "", "enabled": True,
                           "isPrivate": True, "position": "prefix", "role": "other",
                           "roleLabel": "女3"}]}],
            "extra_blocks": [{"id": "fixture-extra", "kind": "negative", "text": "",
                              "enabled": True, "isPrivate": True, "position": "suffix",
                              "role": "main"}],
            "char_references": [{"id": "fixture-ref", "enabled": True, "isPrivate": True,
                                 "image_b64": "", "side": "front", "strength": 0.8,
                                 "fidelity": 0.9, "role": "main", "fileName": ""}],
            "replacements": {"enabled": True, "rules": [{"id": "fixture-rule",
                "enabled": True, "isPrivate": True, "kind": "replace", "scope": "all",
                "from": "", "to": "", "wholeWord": True, "role": "main"}]}}]},
        "character_layers": {"layers": []}}
    aug = {"fixture-preset": {"base_positive": "假正向正文", "base_negative": "假负向正文",
                               "chars": {"fixture-char": {"text": "假角色正文",
                                                            "front_text": "假正面正文",
                                                            "negative": "假角色负向"}},
                               "char_extras": {"fixture-char-extra": "假角色效果"},
                               "extra": {"fixture-extra": "假追加负向"},
                               "charref_images": {"fixture-ref": ""},
                               "repl": {"fixture-rule": {"from": "假旧词", "to": "假新词"}}}}
    # The smoke catalog deliberately has several folders and capsules so visual
    # review covers wrapping, colour separation and disabled/current states.
    template = cfg["augmentation_presets"]["presets"][0]
    for preset_id, name, group, enabled in (
            ("fixture-light", "光", "常用", True),
            ("fixture-dance", "舞萌", "常用", False),
            ("fixture-commission", "委托", "委托", True),
            ("fixture-friend", "朋友的委托", "委托", True),
            ("fixture-spring", "春天", "创作", True),
            ("fixture-white", "白花", "创作", True)):
        shell = json.loads(json.dumps(template, ensure_ascii=False))
        shell.update({"id": preset_id, "name": name, "group": group, "enabled": enabled})
        cfg["augmentation_presets"]["presets"].append(shell)
        aug[preset_id] = {}
    global_private = {"rules": {"fixture-delete": {"word": "假删除词"},
                                  "fixture-replace": {"from": "假原词", "to": "假新词"}}}
    for name, value in (("nai_config.json", cfg), ("nai_augment_private.json", aug),
                        ("nai_character_layers_private.json", {}),
                        ("nai_global_layer_private.json", global_private)):
        (data / name).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def main(argv=None):
    started = time.perf_counter()
    logging.info("启动时间线 入口 main +0ms")
    parser = argparse.ArgumentParser(description="NAI 出图终端 GUI")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--smoke", type=Path, metavar="输出目录")
    args = parser.parse_args(list(argv) if argv is not None else None)
    if args.smoke:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    state_dir = Path(os.environ.get("NAI_GUI_STATE_DIR", tempfile.gettempdir()))
    state_dir.mkdir(parents=True, exist_ok=True)
    instance_lock = None
    if not args.smoke:
        instance_lock = QLockFile(str(state_dir / "gui-instance.lock"))
        if not instance_lock.tryLock(0):
            logging.warning("已有 NAI 出图终端窗口，本次重复启动已拒绝")
            return 3
    # 单参 load：qconfig.load(path, qconfig) 自引用会让运行时 setTheme 死递归爆栈（2026-07-14 Windows 实测二分定位）
    qconfig.load(str(state_dir / "qfluent_config.json"))
    logging.info("启动时间线 qconfig 就绪 +%dms", (time.perf_counter() - started) * 1000)
    app = QApplication.instance() or SafeApplication(sys.argv[:1])
    apply_readable_font(app)
    temp = None
    if args.smoke:
        temp = tempfile.TemporaryDirectory(prefix="nai_gui_fixture_")
        root = Path(temp.name)
        _write_smoke_fixture(root)
    else:
        configured = state_dir / "project_root.txt"
        configured_root = None
        if configured.is_file():
            try:
                configured_root = Path(configured.read_text("utf-8-sig").strip())
            except OSError:
                configured_root = None
        root = args.root or configured_root or Path(__file__).resolve().parents[2]
    terminal = TerminalConfig(root)
    apply_theme("light" if args.smoke else terminal.load().get("ui_theme", "auto"))
    logging.info("启动时间线 配置与主题就绪 +%dms", (time.perf_counter() - started) * 1000)
    window = TerminalWindow(root, smoke=bool(args.smoke))
    if isinstance(app, SafeApplication):
        app.callbackError.connect(window.show_callback_error)
    window.show()
    logging.info("启动时间线 窗口可见 +%dms", (time.perf_counter() - started) * 1000)
    if args.smoke:
        out = args.smoke.resolve()
        out.mkdir(parents=True, exist_ok=True)
        labels = ["终端后台", "全局", "单独预设", "队列", "设置"]
        names = ([f"{i + 1:02d}_浅色_{label}.png" for i, label in enumerate(labels)] +
                 [f"{i + 6:02d}_深色_{label}.png" for i, label in enumerate(labels)])
        index = 0
        wait_started = 0.0

        def switch_page():
            nonlocal wait_started
            window.switchTo(window.pages[index % len(window.pages)])
            wait_started = time.monotonic()
            QTimer.singleShot(50, wait_until_ready)

        def wait_until_ready():
            page = window.pages[index % len(window.pages)]
            content = getattr(page, "content", page)
            ready = content is not None
            # PresetPage has a second asynchronous hand-off after LazyPage is
            # built: wait for its fixture preset/editor as well.
            if ready and getattr(content, "objectName", lambda: "")() == "presetPage":
                ready = (getattr(content, "current", None) is not None and
                         getattr(content, "_editor_widget", None) is not None)
            elapsed = time.monotonic() - wait_started
            if not ready and elapsed < 8.0:
                QTimer.singleShot(100, wait_until_ready)
                return
            if not ready:
                logging.warning("smoke 页面等待超时，按当前状态截图：%s", names[index])
            # Let the completed widget tree finish one layout/paint cycle.
            QTimer.singleShot(400, save_page)

        def save_page():
            nonlocal index
            # QWidget.grab() can leave black compositor tiles around a native
            # table viewport under Qt's offscreen platform.  Render the complete
            # widget tree into one pixmap so the acceptance image matches the
            # real on-screen window.
            pixmap = QPixmap(window.size())
            pixmap.fill(window.palette().window().color())
            window.render(pixmap)
            pixmap.save(str(out / names[index]), "PNG")
            index += 1
            if index == len(window.pages):
                apply_theme("dark")
                QTimer.singleShot(650, switch_page)
            elif index < len(names):
                switch_page()
            else:
                window.close()
                app.quit()
        QTimer.singleShot(250, switch_page)
    code = app.exec()
    if instance_lock is not None:
        instance_lock.unlock()
    if temp:
        temp.cleanup()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
