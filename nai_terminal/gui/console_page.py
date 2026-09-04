from __future__ import annotations

import os
import tempfile
from pathlib import Path

from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import QColor, QDesktopServices, QFont, QPainter, QTextCursor
from PySide6.QtWidgets import (QHBoxLayout, QPlainTextEdit, QVBoxLayout, QWidget)
from qfluentwidgets import (BodyLabel, CardWidget, FluentIcon, PrimaryPushButton,
                            PushButton, StrongBodyLabel, SubtitleLabel, TitleLabel)

from nai_terminal.gui.process_supervisor import ProcessSupervisor, SERVICE_LABELS
from nai_terminal.gui_store import (GuiOwnerLease, managed_process_commands,
                                    win_to_wsl_path)


# 每个状态对应：状态点颜色 / 主标题 / 副说明。颜色在浅深两个主题下都清晰可辨。
STATE_STYLE = {
    "stopped":  ("#9aa0a6", "已停止", "点击「启动」开始监听出图队列。"),
    "starting": ("#f0a020", "启动中…", "正在拉起终端后台，请稍候。"),
    "ready":    ("#2fb344", "运行中", "终端后台正在监听队列，并按顺序向 NAI 执行工单。"),
    "external": ("#3b82f6", "外部运行", "检测到已有终端后台在运行（非本面板启动，不能在此停止）。"),
    "stopping": ("#f0a020", "停止中…", "正在安全停止终端后台。"),
    "failed":   ("#e5484d", "启动失败", "终端后台没有起来，请查看下方运行日志排查原因。"),
}


class StatusDot(QWidget):
    """A crisp anti-aliased status light next to the service state."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(16, 16)
        self._color = QColor(STATE_STYLE["stopped"][0])

    def set_color(self, color: str) -> None:
        self._color = QColor(color)
        self.update()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        # A faint outer halo so the light reads on both light and dark cards.
        halo = QColor(self._color)
        halo.setAlpha(70)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(halo)
        painter.drawEllipse(0, 0, 16, 16)
        painter.setBrush(self._color)
        painter.drawEllipse(3, 3, 10, 10)


class ConsolePage(QWidget):
    """The terminal-backend control: start/stop the worker and watch its log.

    Everything from the old Owner control panel (WSL / VSCode / ComfyUI / project
    shortcuts) has been dropped on purpose — the desktop control panel already
    covers those.  This page owns exactly one job: the NAI 出图 worker.
    """

    def __init__(self, client, executor, root=None, smoke=False, parent=None):
        super().__init__(parent)
        self.setObjectName("consolePage")
        self.client = client
        self.executor = executor
        self.smoke = smoke
        self.scroll_paused = False
        self.detected_once = False
        self._pending_logs: list[str] = []

        wsl_root = win_to_wsl_path(str(root)) if root else "/home/user/auto-illustrate"
        if smoke and root:
            state_dir = Path(root) / ".gui-smoke-state"
        else:
            configured_state = os.environ.get("NAI_GUI_STATE_DIR")
            state_dir = (Path(configured_state) if configured_state else
                         Path(tempfile.gettempdir()) / "nai-terminal-gui")
        self.owner_lease = GuiOwnerLease.create(state_dir)
        self.lease_timer = QTimer(self)
        self.lease_timer.setInterval(1000)
        self.lease_timer.timeout.connect(self._heartbeat_owner)
        self.lease_timer.start()
        self._lease_error_reported = False
        self.commands = managed_process_commands(
            wsl_root, owner_lease=win_to_wsl_path(str(self.owner_lease.path)),
            owner_token=self.owner_lease.token)
        self.supervisor = ProcessSupervisor(self.commands, client, executor, self)
        self.supervisor.logReceived.connect(self.append_process_log)
        self.supervisor.serviceStateChanged.connect(self.service_state_changed)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(26, 22, 26, 22)
        layout.setSpacing(14)

        title = TitleLabel("终端后台")
        subtitle = BodyLabel("读取出图队列、套用终端预设，按顺序向 NAI 执行工单。")
        subtitle.setWordWrap(True)
        layout.addWidget(title)
        layout.addWidget(subtitle)

        layout.addWidget(self._build_service_card())

        log_actions = QHBoxLayout()
        log_actions.addWidget(SubtitleLabel("运行日志"))
        log_actions.addStretch(1)
        self.open_logs = PushButton(FluentIcon.DOCUMENT, "打开日志目录")
        self.pause_log = PushButton("暂停滚动")
        clear = PushButton("清空")
        self.open_logs.clicked.connect(self.open_log_folder)
        self.pause_log.clicked.connect(self.toggle_scroll)
        clear.clicked.connect(self.clear_log)
        for button in (self.open_logs, self.pause_log, clear):
            button.setMinimumHeight(32)
            log_actions.addWidget(button)
        layout.addLayout(log_actions)

        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMinimumHeight(200)
        self.log.setPlaceholderText("终端后台的运行日志会显示在这里。")
        self.log.document().setMaximumBlockCount(2400)
        mono = QFont("Cascadia Mono")
        mono.setPixelSize(14)
        self.log.setFont(mono)
        self.log.setStyleSheet(
            "QPlainTextEdit { background:#0b0d10; color:#eaeef2; border:1px solid #2a2f37; "
            "border-radius:8px; padding:10px; selection-background-color:#0078d4; }")
        layout.addWidget(self.log, 1)

        self.log_flush = QTimer(self)
        self.log_flush.setSingleShot(True)
        self.log_flush.setInterval(50)
        self.log_flush.timeout.connect(self.flush_logs)

        self.set_state("stopped")
        if smoke:
            self.set_state("ready")
            self.append_process_log("worker", "[假数据] 终端后台已就绪，正在监听队列")

    def _build_service_card(self) -> CardWidget:
        card = CardWidget(self)
        card.setMinimumHeight(96)
        row = QHBoxLayout(card)
        row.setContentsMargins(22, 16, 22, 16)
        row.setSpacing(14)

        self.dot = StatusDot(card)
        row.addWidget(self.dot, 0, Qt.AlignmentFlag.AlignVCenter)

        text = QVBoxLayout()
        text.setSpacing(3)
        self.state_label = StrongBodyLabel("已停止")
        self.state_detail = BodyLabel("")
        self.state_detail.setWordWrap(True)
        text.addWidget(self.state_label)
        text.addWidget(self.state_detail)
        row.addLayout(text, 1)

        self.start_button = PrimaryPushButton(FluentIcon.PLAY, "启动")
        self.stop_button = PushButton(FluentIcon.POWER_BUTTON, "停止")
        for button in (self.start_button, self.stop_button):
            button.setMinimumHeight(40)
            button.setMinimumWidth(96)
        self.start_button.clicked.connect(self.supervisor.start_worker)
        self.stop_button.clicked.connect(lambda: self.supervisor.stop_service("worker"))
        row.addWidget(self.start_button, 0, Qt.AlignmentFlag.AlignVCenter)
        row.addWidget(self.stop_button, 0, Qt.AlignmentFlag.AlignVCenter)
        return card

    def showEvent(self, event):
        super().showEvent(event)
        if not self.smoke and not self.detected_once:
            self.detected_once = True
            self.supervisor.detect()

    def service_state_changed(self, key: str, state: str) -> None:
        # Only the worker drives this page; the supervisor's dormant vite slot is
        # never started here and is deliberately ignored.
        if key == "worker":
            self.set_state(state)

    def set_state(self, state: str) -> None:
        color, label, detail = STATE_STYLE.get(state, ("#9aa0a6", state, ""))
        self.dot.set_color(color)
        self.state_label.setText(label)
        self.state_detail.setText(detail)
        self.start_button.setEnabled(state not in {"starting", "ready", "stopping"})
        # An externally running worker is not ours, so we never offer to stop it.
        self.stop_button.setEnabled(state in {"starting", "ready", "stopping"})

    def append_process_log(self, source: str, raw: str) -> None:
        label = SERVICE_LABELS.get(source, "启动器")
        for line in str(raw or "").replace("\r\n", "\n").replace("\r", "\n").splitlines():
            if line:
                self._pending_logs.append(f"[{label}] {line}")
        if self._pending_logs and not self.log_flush.isActive():
            self.log_flush.start()

    def flush_logs(self) -> None:
        if not self._pending_logs:
            return
        text = "\n".join(self._pending_logs)
        self._pending_logs.clear()
        cursor = self.log.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        if self.log.document().blockCount() > 1 or self.log.toPlainText():
            cursor.insertText("\n")
        cursor.insertText(text)
        if not self.scroll_paused:
            self.log.setTextCursor(cursor)
            self.log.ensureCursorVisible()

    def clear_log(self) -> None:
        self._pending_logs.clear()
        self.log.clear()

    def toggle_scroll(self) -> None:
        self.scroll_paused = not self.scroll_paused
        self.pause_log.setText("恢复滚动" if self.scroll_paused else "暂停滚动")

    def open_log_folder(self) -> None:
        base = os.environ.get("NAI_GUI_STATE_DIR") or str(
            Path(os.environ.get("LOCALAPPDATA", Path.home())) / "nai-terminal-gui")
        Path(base).mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(Path(base))))

    def _heartbeat_owner(self) -> None:
        try:
            self.owner_lease.heartbeat()
        except OSError:
            if not self._lease_error_reported:
                self._lease_error_reported = True
                self.append_process_log(
                    "launcher", "GUI 所有权心跳失败；后台将自动停止，请重新打开终端窗口")

    def has_owned_services(self) -> bool:
        return self.supervisor.has_owned_services()

    def stop_managed_and_wait(self, timeout_ms: int = 10000) -> bool:
        return self.supervisor.stop_all_blocking(timeout_ms)

    def shutdown(self) -> None:
        self.flush_logs()
        self.lease_timer.stop()
        self.owner_lease.close()
        self.supervisor.dispose()
