from __future__ import annotations

import copy
from datetime import datetime

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWidgets import QAbstractButton, QComboBox, QDoubleSpinBox, QLineEdit, QTextEdit


class AutoSaveController(QObject):
    """Debounce UI edits and serialize frozen snapshots on the IO executor.

    Keystrokes only advance a cheap revision counter.  Older code canonicalised
    the complete preset (including reference-image blobs) on the UI thread after
    every debounce, which caused visible pauses.  Revisions also let callers
    freeze a second snapshot while an earlier save is still running.

    ``flush_then(callback)`` is the hand-off primitive for page switching:
    it freezes the current page *before* the caller replaces its model and calls
    ``callback(error)`` only after that revision has reached the writer.
    """

    def __init__(self, executor, snapshot, writer, status, delay=1000, parent=None):
        super().__init__(parent)
        self.executor = executor
        self.snapshot = snapshot
        self.writer = writer
        self.status = status
        self._generation = 0
        self._revision = 0
        self._saved_by_generation = {0: 0}
        self._inflight_by_generation: dict[int, set[int]] = {}
        self._waiters: list[tuple[int, int, object]] = []
        self._pending_writes = 0
        self.saving = False
        self.dirty_while_saving = False
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.setInterval(delay)
        self.timer.timeout.connect(self.save_now)

    def seed(self, _value=None):
        """Mark a freshly loaded model clean without scanning/canonicalising it.

        ``_value`` remains accepted so existing pages keep working.  New callers
        should simply call ``seed()`` after constructing their editor.
        """
        self.timer.stop()
        self._generation += 1
        self._revision = 0
        self._saved_by_generation[self._generation] = 0
        self.dirty_while_saving = False

    def changed(self, *_args):
        self._revision += 1
        self.dirty_while_saving = self.saving
        self.status.setText("等待自动保存…")
        self.timer.start()

    def watch(self, root):
        for widget in root.findChildren(QLineEdit):
            widget.textChanged.connect(self.changed)
        for widget in root.findChildren(QTextEdit):
            widget.textChanged.connect(self.changed)
        for widget in root.findChildren(QComboBox):
            widget.currentIndexChanged.connect(self.changed)
        for widget in root.findChildren(QDoubleSpinBox):
            widget.valueChanged.connect(self.changed)
        for widget in root.findChildren(QAbstractButton):
            if not hasattr(widget, "menu") or widget.menu() is None:
                widget.toggled.connect(self.changed)
        # qfluentwidgets SwitchButton is not a QAbstractButton.
        for widget in root.findChildren(QObject):
            for name in ("checkedChanged", "currentItemChanged"):
                signal = getattr(widget, name, None)
                if signal is not None:
                    try:
                        signal.connect(self.changed)
                    except (RuntimeError, TypeError):
                        pass

    def _saved_revision(self, generation):
        return self._saved_by_generation.get(generation, 0)

    def _covered_revision(self, generation):
        covered = self._saved_revision(generation)
        inflight = self._inflight_by_generation.get(generation)
        return max(covered, max(inflight)) if inflight else covered

    def is_dirty(self):
        return self._revision > self._saved_revision(self._generation)

    def _queue_current_snapshot(self):
        generation, revision = self._generation, self._revision
        if revision <= self._covered_revision(generation):
            return False, None
        try:
            value = copy.deepcopy(self.snapshot())
        except Exception as exc:
            self.status.setText("自动保存准备失败；详情见 gui.log")
            return False, exc

        self._inflight_by_generation.setdefault(generation, set()).add(revision)
        self._pending_writes += 1
        self.saving = True
        self.dirty_while_saving = self._revision > revision
        self.status.setText("保存中…")

        def done(_result, error):
            inflight = self._inflight_by_generation.get(generation)
            if inflight is not None:
                inflight.discard(revision)
                if not inflight:
                    self._inflight_by_generation.pop(generation, None)
            self._pending_writes = max(0, self._pending_writes - 1)
            self.saving = self._pending_writes > 0
            if error is not None:
                if generation == self._generation:
                    self.status.setText("自动保存失败；详情见 gui.log")
                import logging
                logging.error("自动保存失败",
                              exc_info=(type(error), error, error.__traceback__))
            else:
                self._saved_by_generation[generation] = max(
                    self._saved_revision(generation), revision)
                if generation == self._generation:
                    if self.is_dirty():
                        self.status.setText("等待自动保存…")
                    else:
                        self.status.setText(
                            "已自动保存 " + datetime.now().strftime("%H:%M:%S"))
            self.dirty_while_saving = self.saving and self.is_dirty()
            self._resolve_waiters(generation, revision, error)
            if error is not None and generation == self._generation and self.is_dirty():
                self.timer.start()

        try:
            self.executor.submit(lambda: self.writer(value), done)
        except Exception as exc:
            done(None, exc)
            return False, exc
        return True, None

    def _resolve_waiters(self, generation, completed_revision, error):
        callbacks = []
        remaining = []
        saved = self._saved_revision(generation)
        outstanding = self._inflight_by_generation.get(generation, set())
        for gen, target, callback in self._waiters:
            if gen != generation:
                remaining.append((gen, target, callback))
            elif saved >= target:
                callbacks.append((callback, None))
            elif error is not None and target <= completed_revision and not any(
                    revision >= target for revision in outstanding):
                callbacks.append((callback, error))
            else:
                remaining.append((gen, target, callback))
        self._waiters = remaining
        for callback, callback_error in callbacks:
            callback(callback_error)

    def save_now(self):
        """Freeze and queue the newest dirty revision immediately.

        Unlike the old implementation this also queues a newer frozen snapshot
        while an earlier save is running, so shutdown can safely drain both.
        """
        self.timer.stop()
        queued, _error = self._queue_current_snapshot()
        if not queued and not self.is_dirty() and not self.saving:
            self.status.setText("内容无变化，无需写盘")
        return queued

    def flush_then(self, callback):
        """Save the current revision, then call ``callback(error)``.

        PresetPage must use this before replacing ``self.current``.  The frozen
        snapshot is queued immediately even when another write is in flight.
        """
        self.timer.stop()
        generation, target = self._generation, self._revision
        if self._saved_revision(generation) >= target:
            callback(None)
            return
        self._waiters.append((generation, target, callback))
        _queued, error = self._queue_current_snapshot()
        if error is not None:
            # Snapshot preparation failed before a writer callback could resolve it.
            self._waiters = [item for item in self._waiters
                             if not (item[0] == generation and item[1] == target
                                     and item[2] is callback)]
            callback(error)

    def flush(self):
        """Freeze the latest snapshot without waiting (safe before executor shutdown)."""
        return self.save_now()

    def cancel_pending(self):
        self.timer.stop()
        self._saved_by_generation[self._generation] = self._revision
        self.dirty_while_saving = False
