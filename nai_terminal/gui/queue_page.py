from __future__ import annotations

from PySide6.QtCore import QObject, QThread, QTimer, Qt, Signal, Slot
from PySide6.QtWidgets import (QAbstractItemView, QHBoxLayout, QTableWidgetItem,
                               QVBoxLayout, QWidget)
from qfluentwidgets import BodyLabel, PushButton, TableWidget, TitleLabel

from nai_terminal.gui_store import QueueUnavailable


STATUS = {"queued": "排队中", "preparing": "准备中", "submitting": "提交中",
          "saving": "保存中", "succeeded": "已完成", "partial": "部分完成",
          "failed": "失败", "cancelled": "已取消", "recovery_required": "需要恢复"}


class QueueWorker(QObject):
    updated = Signal(object, bool)
    failed = Signal(str)

    def __init__(self, client):
        super().__init__()
        self.client = client
        self.timer = None

    @Slot()
    def start(self):
        if self.timer is None:
            self.timer = QTimer(self)
            self.timer.setInterval(2000)
            self.timer.timeout.connect(self.refresh)
        if not self.timer.isActive():
            self.timer.start()
            self.refresh()

    @Slot()
    def stop(self):
        if self.timer:
            self.timer.stop()

    @Slot()
    def refresh(self):
        try:
            queue = self.client.queue()
            jobs = self.client.jobs(50).get("jobs") or []
            for job in jobs:
                if QThread.currentThread().isInterruptionRequested():
                    return
                try:
                    job["detail"] = self.client.job(job["job_id"])
                except QueueUnavailable:
                    job["detail"] = {}
            self.updated.emit(jobs, bool(queue.get("paused")))
        except Exception:
            self.failed.emit("终端未启动")

    @Slot(str, object)
    def action(self, name, payload):
        try:
            if name == "cancel":
                self.client.cancel(payload["job_id"])
            elif name == "resume":
                self.client.resume(payload["job_id"])
            elif name == "priority":
                self.client.priority(payload["job_id"], payload["sort_key"])
            elif name == "pause":
                self.client.pause(bool(payload))
            self.refresh()
        except Exception:
            self.failed.emit("终端未启动")


class QueuePage(QWidget):
    start_polling = Signal()
    stop_polling = Signal()
    request_action = Signal(str, object)

    def __init__(self, client, smoke=False, parent=None):
        super().__init__(parent)
        self.setObjectName("queuePage")
        self.jobs = []
        self.paused = False
        self.smoke = smoke
        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 28, 32, 28)
        layout.addWidget(TitleLabel("队列"))
        self.state = BodyLabel("正在连接终端…")
        layout.addWidget(self.state)
        self.table = TableWidget(self)
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(["文件夹名", "状态", "进度", "预估 Anlas", "任务编号"])
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.horizontalHeader().setStretchLastSection(True)
        layout.addWidget(self.table)
        actions = QHBoxLayout()
        for text, slot in (("取消", self.cancel), ("上移", lambda: self.move(-1)),
                           ("下移", lambda: self.move(1)), ("恢复任务", self.resume)):
            button = PushButton(text)
            button.setMinimumHeight(36)
            button.clicked.connect(slot)
            actions.addWidget(button)
        self.pause_button = PushButton("暂停队列")
        self.pause_button.setMinimumHeight(36)
        self.pause_button.clicked.connect(self.toggle_pause)
        actions.addWidget(self.pause_button)
        actions.addStretch(1)
        layout.addLayout(actions)
        self.thread = None
        self.worker = None
        if smoke:
            self.show_fixture()
        else:
            self.thread = QThread(self)
            self.worker = QueueWorker(client)
            self.worker.moveToThread(self.thread)
            self.start_polling.connect(self.worker.start)
            self.stop_polling.connect(self.worker.stop)
            self.request_action.connect(self.worker.action)
            self.worker.updated.connect(self._updated)
            self.worker.failed.connect(self.state.setText)
            self.thread.start()

    def showEvent(self, event):
        super().showEvent(event)
        if not self.smoke:
            self.start_polling.emit()

    def hideEvent(self, event):
        if not self.smoke:
            self.stop_polling.emit()
        super().hideEvent(event)

    @Slot(object, bool)
    def _updated(self, jobs, paused):
        self.paused = paused
        self.populate(jobs)
        self.state.setText("队列已暂停" if paused else "终端已连接")
        self.pause_button.setText("恢复队列" if paused else "暂停队列")

    def selected(self):
        row = self.table.currentRow()
        return self.jobs[row] if 0 <= row < len(self.jobs) else None

    def populate(self, jobs):
        self.jobs = jobs
        self.table.setRowCount(len(jobs))
        for row, job in enumerate(jobs):
            progress = job.get("detail", {}).get("progress", {})
            done = progress.get("succeeded", 0)
            total = progress.get("total", job.get("max_images", 0))
            values = [job.get("display_name", ""), STATUS.get(job.get("status"), "未知"),
                      f"{done}/{total}", str(job.get("estimated_anlas", 0)), job.get("job_id", "")]
            for col, value in enumerate(values):
                self.table.setItem(row, col, QTableWidgetItem(str(value)))

    def show_fixture(self):
        self.state.setText("内置假数据（烟测）")
        self.populate([{"job_id": "fixture-job", "display_name": "假数据文件夹",
                        "status": "queued", "sort_key": 10.0, "estimated_anlas": 5,
                        "max_images": 2, "detail": {"progress": {"total": 2, "succeeded": 1}}}])

    def cancel(self):
        job = self.selected()
        if job:
            self.request_action.emit("cancel", {"job_id": job["job_id"]})

    def resume(self):
        job = self.selected()
        if job and job.get("status") == "recovery_required":
            self.request_action.emit("resume", {"job_id": job["job_id"]})

    def move(self, direction):
        row = self.table.currentRow()
        other = row + direction
        if not (0 <= row < len(self.jobs) and 0 <= other < len(self.jobs)):
            return
        job, neighbor = self.jobs[row], self.jobs[other]
        target = float(neighbor.get("sort_key", 0)) + (-0.001 if direction < 0 else 0.001)
        self.request_action.emit("priority", {"job_id": job["job_id"], "sort_key": target})

    def toggle_pause(self):
        self.request_action.emit("pause", not self.paused)

    def shutdown(self):
        if self.thread:
            self.stop_polling.emit()
            self.thread.requestInterruption()
            self.thread.quit()
            self.thread.wait()
