"""Qt worker helpers; every callable runs off the GUI thread."""
from __future__ import annotations

import itertools
import logging

from PySide6.QtCore import QObject, QThread, Signal, Slot


class _CallableWorker(QObject):
    finished = Signal(int, object, object)

    @Slot(int, object)
    def run(self, task_id, function):
        try:
            self.finished.emit(task_id, function(), None)
        except Exception as exc:
            self.finished.emit(task_id, None, exc)


class BackgroundExecutor(QObject):
    """One serialized IO lane, with callbacks always delivered on the UI thread."""

    requested = Signal(int, object)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._ids = itertools.count(1)
        self._callbacks = {}
        self.thread = QThread(self)
        self.worker = _CallableWorker()
        self.worker.moveToThread(self.thread)
        self.requested.connect(self.worker.run)
        self.worker.finished.connect(self._finish)
        self.thread.start()

    def submit(self, function, callback):
        task_id = next(self._ids)
        self._callbacks[task_id] = callback
        self.requested.emit(task_id, function)
        return task_id

    @Slot(int, object, object)
    def _finish(self, task_id, result, error):
        callback = self._callbacks.pop(task_id, None)
        if error is not None:
            logging.error("后台 IO 任务失败", exc_info=error)
        if callback:
            callback(result, error)

    def shutdown(self):
        self.thread.quit()
        if not self.thread.wait(10000):
            logging.warning("仍在等待后台写盘完成")
            self.thread.wait()
