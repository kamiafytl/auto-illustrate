"""Qt process ownership for the launcher page.

The GUI owns only children it started itself.  Every WSL child runs in a unique
process group and prints its Linux PID before exec; stop therefore targets one
validated group instead of using a wildcard process name.
"""
from __future__ import annotations

import time
import urllib.request

from PySide6.QtCore import QObject, QProcess, QTimer, Signal

from nai_terminal.gui_store import (MANAGED_PID_PREFIX, ManagedProcessCommand,
                                    managed_stop_command, strip_terminal_escapes)


SERVICE_LABELS = {"worker": "终端后台", "vite": "Webapp"}


class ManagedService(QObject):
    logReceived = Signal(str, str)
    stateChanged = Signal(str, str)
    stopped = Signal(str)

    def __init__(self, key: str, command: ManagedProcessCommand, parent=None):
        super().__init__(parent)
        self.key = key
        self.command = command
        self.state = "stopped"
        self.owned = False
        self.linux_pid: int | None = None
        self._carry = ""
        self._stop_process: QProcess | None = None
        self._kill_timer = QTimer(self)
        self._kill_timer.setSingleShot(True)
        self._kill_timer.timeout.connect(self._force_stop)

        self.process = QProcess(self)
        self.process.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        self.process.readyReadStandardOutput.connect(self._read)
        self.process.started.connect(self._started)
        self.process.finished.connect(self._finished)
        self.process.errorOccurred.connect(self._error)

    def _set_state(self, value: str) -> None:
        if value != self.state:
            self.state = value
            self.stateChanged.emit(self.key, value)

    def _emit(self, text: str) -> None:
        clean = strip_terminal_escapes(text).strip("\r\n")
        if clean:
            self.logReceived.emit(self.key, clean)

    def start(self) -> bool:
        if self.process.state() != QProcess.ProcessState.NotRunning:
            return False
        self.owned = True
        self.linux_pid = None
        self._carry = ""
        self._set_state("starting")
        program, arguments = self.command.qprocess_command()
        self.process.start(program, arguments)
        return True

    def _started(self) -> None:
        self._emit(f"{SERVICE_LABELS[self.key]}子进程已建立，正在等待就绪…")

    def _read(self) -> None:
        raw = bytes(self.process.readAllStandardOutput()).decode("utf-8", "replace")
        text = self._carry + raw.replace("\r\n", "\n").replace("\r", "\n")
        parts = text.split("\n")
        self._carry = parts.pop()
        for line in parts:
            if line.startswith(MANAGED_PID_PREFIX):
                try:
                    self.linux_pid = int(line[len(MANAGED_PID_PREFIX):].strip())
                except ValueError:
                    self._emit("启动器未能识别受管进程编号")
                continue
            self._emit(line)

    def mark_ready(self) -> None:
        running = self.process.state() != QProcess.ProcessState.NotRunning
        if not (self.owned and running):
            self.owned = False
            self.linux_pid = None
            self._set_state("external")
        else:
            self._set_state("ready")

    def mark_stopped_if_external(self) -> None:
        if not self.owned and self.process.state() == QProcess.ProcessState.NotRunning:
            self._set_state("stopped")

    def _error(self, error) -> None:
        if self.state != "stopping":
            self._set_state("failed")
            self._emit(f"{SERVICE_LABELS[self.key]}启动失败：{self.process.errorString()}")
        if error == QProcess.ProcessError.FailedToStart:
            self.owned = False
            self.linux_pid = None
            self.stopped.emit(self.key)

    def _finished(self, exit_code: int, _status) -> None:
        if self._carry:
            self._emit(self._carry)
            self._carry = ""
        was_stopping = self.state == "stopping"
        self._kill_timer.stop()
        self.owned = False
        self.linux_pid = None
        self._set_state("stopped" if was_stopping or exit_code == 0 else "failed")
        # An unrequested exit is always reported, including code 0: a service
        # that quits on its own is a failure of this panel's job, and silence
        # would leave the user staring at "启动失败" with an empty log.
        if not was_stopping:
            self._emit(f"{SERVICE_LABELS[self.key]}已退出（代码 {exit_code}）")
        self.stopped.emit(self.key)

    def stop(self) -> bool:
        if not self.owned:
            if self.state == "external":
                self._emit(f"{SERVICE_LABELS[self.key]}不是本面板启动的，未擅自终止")
            return False
        if self.linux_pid is None:
            self._set_state("failed")
            self._emit(f"{SERVICE_LABELS[self.key]}缺少精确进程编号，已拒绝模糊终止")
            return False
        self._set_state("stopping")
        self._run_stop_signal("TERM")
        self._kill_timer.start(5000)
        return True

    def _run_stop_signal(self, signal: str) -> None:
        if self.linux_pid is None:
            return
        process = QProcess(self)
        process.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        process.readyReadStandardOutput.connect(
            lambda p=process: self._emit(bytes(p.readAllStandardOutput()).decode("utf-8", "replace")))
        process.finished.connect(lambda *_args, p=process: self._stop_command_finished(p))
        self._stop_process = process
        program, arguments = managed_stop_command(
            self.linux_pid, self.command.signature,
            launcher=self.command.launcher, signal=signal)
        process.start(program, arguments)

    def _stop_command_finished(self, process: QProcess) -> None:
        if process.exitCode() != 0 and self.state == "stopping":
            self._emit(f"{SERVICE_LABELS[self.key]}精确终止命令失败")
        process.deleteLater()
        if self._stop_process is process:
            self._stop_process = None

    def _force_stop(self) -> None:
        if self.owned and self.state == "stopping" and self.linux_pid is not None:
            self._emit(f"{SERVICE_LABELS[self.key]}未及时退出，正在精确强制终止")
            self._run_stop_signal("KILL")

    def stop_blocking(self, timeout_ms: int = 8000) -> bool:
        if not self.owned:
            return True
        if not self.stop():
            return False
        deadline = time.monotonic() + max(0, timeout_ms) / 1000
        if self._stop_process is not None:
            self._stop_process.waitForFinished(min(3000, timeout_ms))
        remaining = max(0, int((deadline - time.monotonic()) * 1000))
        if self.process.waitForFinished(remaining):
            return True
        self._force_stop()
        if self._stop_process is not None:
            self._stop_process.waitForFinished(2000)
        return self.process.waitForFinished(2000)


class ProcessSupervisor(QObject):
    logReceived = Signal(str, str)
    serviceStateChanged = Signal(str, str)
    overallStateChanged = Signal(str)
    allReady = Signal()
    allStopped = Signal()

    def __init__(self, commands: dict, queue_client, executor, parent=None):
        super().__init__(parent)
        self.queue_client = queue_client
        self.executor = executor
        self.services = {
            key: ManagedService(key, commands[key], self) for key in ("worker", "vite")
        }
        for service in self.services.values():
            service.logReceived.connect(self.logReceived)
            service.stateChanged.connect(self.serviceStateChanged)
            service.stopped.connect(lambda _key: self._check_stopped())
        self._sequence: str | None = None
        self._deadline = 0.0
        self._probe_pending = False
        # Services this panel has already asked to start in the current
        # sequence.  A service is launched at most once per click: the health
        # probe runs every 350 ms while a cold start needs seconds, so without
        # this the retry loop would fire a second copy that dies on the port the
        # first one is still binding.
        self._launched: set[str] = set()
        self._stop_poll = QTimer(self)
        self._stop_poll.setInterval(150)
        self._stop_poll.timeout.connect(self._check_stopped)

    @staticmethod
    def _probe_http(url: str) -> bool:
        with urllib.request.urlopen(url, timeout=0.7) as response:
            return response.status < 500

    def detect(self) -> None:
        if self._sequence is not None:
            return
        self._sequence = "detect-worker"
        self._probe_worker()

    def start_all(self) -> None:
        if self._probe_pending:
            QTimer.singleShot(120, self.start_all)
            return
        self._sequence = "all-worker"
        self._deadline = time.monotonic() + 60
        self._launched.clear()
        self.overallStateChanged.emit("正在启动")
        self._ensure_worker()

    def start_worker(self) -> None:
        if self._probe_pending:
            QTimer.singleShot(120, self.start_worker)
            return
        self._sequence = "worker"
        self._deadline = time.monotonic() + 30
        self._launched.discard("worker")
        self.overallStateChanged.emit("正在启动终端后台")
        self._ensure_worker()

    def start_vite(self) -> None:
        if self._probe_pending:
            QTimer.singleShot(120, self.start_vite)
            return
        self._sequence = "vite"
        self._deadline = time.monotonic() + 40
        self._launched.discard("vite")
        self.overallStateChanged.emit("正在启动 Webapp")
        self._ensure_vite()

    def _submit_probe(self, function, callback) -> None:
        if self._probe_pending:
            return
        self._probe_pending = True

        def done(result, error):
            self._probe_pending = False
            callback(error is None and bool(result))

        self.executor.submit(function, done)

    def _probe_worker(self) -> None:
        self._submit_probe(lambda: bool(self.queue_client.queue()), self._detected_worker)

    def _detected_worker(self, ready: bool) -> None:
        if ready:
            self.services["worker"].mark_ready()
        else:
            self.services["worker"].mark_stopped_if_external()
        self._sequence = "detect-vite"
        self._submit_probe(
            lambda: self._probe_http(self.services["vite"].command.health_url),
            self._detected_vite)

    def _detected_vite(self, ready: bool) -> None:
        if ready:
            self.services["vite"].mark_ready()
        else:
            self.services["vite"].mark_stopped_if_external()
        self._sequence = None
        if any(s.state in {"ready", "external"} for s in self.services.values()):
            self.overallStateChanged.emit("已有服务运行")
        else:
            self.overallStateChanged.emit("已停止")

    def _ensure_worker(self) -> None:
        self._submit_probe(lambda: bool(self.queue_client.queue()), self._worker_checked)

    def _worker_checked(self, ready: bool) -> None:
        if ready:
            self.services["worker"].mark_ready()
            if self._sequence == "all-worker":
                self._sequence = "all-vite"
                self._ensure_vite()
            else:
                self._sequence = None
                self.overallStateChanged.emit("终端后台运行中")
            return
        if not self._start_once("worker"):
            return
        self._retry(self._ensure_worker, "终端后台启动超时；请查看上方日志")

    def _ensure_vite(self) -> None:
        self._submit_probe(
            lambda: self._probe_http(self.services["vite"].command.health_url),
            self._vite_checked)

    def _vite_checked(self, ready: bool) -> None:
        if ready:
            self.services["vite"].mark_ready()
            sequence = self._sequence
            self._sequence = None
            self.overallStateChanged.emit("运行中")
            if sequence == "all-vite":
                self.allReady.emit()
            return
        if not self._start_once("vite"):
            return
        self._retry(self._ensure_vite, "Webapp 启动超时；请查看上方日志")

    def _start_once(self, key: str) -> bool:
        """Launch *key* at most once per sequence; report a service that died.

        Returns False when the sequence has ended (failure), True when the
        caller should keep polling for readiness.
        """
        service = self.services[key]
        if service.state == "failed":
            self._abort(f"{SERVICE_LABELS[key]}启动失败；请查看上方日志")
            return False
        if key in self._launched:
            if service.process.state() == QProcess.ProcessState.NotRunning:
                # Started by us, gone again, and still not answering: relaunching
                # would only race the port it may still hold.
                self._abort(f"{SERVICE_LABELS[key]}启动后已退出；请查看上方日志")
                return False
            return True
        self._launched.add(key)
        service.start()
        return True

    def _abort(self, message: str) -> None:
        self._sequence = None
        self.overallStateChanged.emit("启动失败")
        self.logReceived.emit("launcher", message)

    def _retry(self, callback, timeout_message: str) -> None:
        if time.monotonic() >= self._deadline:
            self._sequence = None
            self.overallStateChanged.emit("启动失败")
            self.logReceived.emit("launcher", timeout_message)
            return
        QTimer.singleShot(350, callback)

    def stop_service(self, key: str) -> None:
        service = self.services[key]
        if service.stop():
            self.overallStateChanged.emit("正在停止")

    def stop_all(self) -> None:
        self._sequence = None
        self.overallStateChanged.emit("正在停止")
        owned = False
        for key in ("vite", "worker"):
            owned = self.services[key].stop() or owned
        if owned:
            self._stop_poll.start()
        else:
            self._check_stopped()

    def _check_stopped(self) -> None:
        if any(service.owned for service in self.services.values()):
            return
        self._stop_poll.stop()
        external = any(service.state == "external" for service in self.services.values())
        self.overallStateChanged.emit("外部服务仍在运行" if external else "已停止")
        self.allStopped.emit()

    def has_owned_services(self) -> bool:
        return any(service.owned for service in self.services.values())

    def stop_all_blocking(self, timeout_ms: int = 10000) -> bool:
        deadline = time.monotonic() + max(0, timeout_ms) / 1000
        ok = True
        for key in ("vite", "worker"):
            remaining = max(0, int((deadline - time.monotonic()) * 1000))
            ok = self.services[key].stop_blocking(remaining) and ok
        return ok

    def dispose(self) -> None:
        self._sequence = None
        self._stop_poll.stop()
