from __future__ import annotations

import uuid

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QFormLayout, QHBoxLayout, QScrollArea,
                               QVBoxLayout, QWidget)
from qfluentwidgets import (BodyLabel, CardWidget, CheckBox, ComboBox, FluentIcon,
                            LineEdit, PushButton, SubtitleLabel, TitleLabel,
                            TransparentToolButton)

from nai_terminal.gui.autosave import AutoSaveController


SCOPE_LABELS = [("全部", "all"), ("正向", "positive"), ("负向", "negative")]


class GlobalRuleRow(CardWidget):
    def __init__(self, kind: str, value: dict | None = None, parent=None):
        super().__init__(parent)
        self.kind = kind
        self.rule_id = str((value or {}).get("id") or f"global-{uuid.uuid4().hex[:12]}")
        form = QFormLayout(self)
        head = QHBoxLayout()
        head.addWidget(SubtitleLabel("删除规则" if kind == "delete" else "替换规则"))
        head.addStretch(1)
        self.remove_button = TransparentToolButton(FluentIcon.DELETE)
        self.remove_button.setToolTip("删除此规则")
        head.addWidget(self.remove_button)
        form.addRow(head)
        self.enabled = CheckBox("启用")
        self.enabled.setChecked(bool((value or {}).get("enabled", True)))
        self.scope = ComboBox()
        for label, code in SCOPE_LABELS:
            self.scope.addItem(label, userData=code)
        self.scope.setCurrentIndex(max(self.scope.findData((value or {}).get("scope") or "all"), 0))
        self.source = LineEdit()
        self.source.setText((value or {}).get("word" if kind == "delete" else "from", ""))
        self.target = LineEdit() if kind == "replace" else None
        if self.target:
            self.target.setText((value or {}).get("to", ""))
        for widget in (self.scope, self.source):
            widget.setMinimumHeight(36)
        form.addRow(BodyLabel("状态："), self.enabled)
        form.addRow(BodyLabel("作用范围："), self.scope)
        form.addRow(BodyLabel("删除词：" if kind == "delete" else "原词："), self.source)
        if self.target:
            self.target.setMinimumHeight(36)
            form.addRow(BodyLabel("替换为："), self.target)

    def value(self):
        out = {"id": self.rule_id, "kind": self.kind, "scope": self.scope.currentData(),
               "enabled": self.enabled.isChecked()}
        if self.kind == "delete":
            out["word"] = self.source.text()
        else:
            out["from"] = self.source.text()
            out["to"] = self.target.text()
        return out


class GlobalPage(QWidget):
    def __init__(self, config_store, private_store, executor, available=True, parent=None):
        super().__init__(parent)
        self.setObjectName("globalPage")
        self.config_store = config_store
        self.private_store = private_store
        self.executor = executor
        self.available = available
        self.loaded = False
        self.rows = []
        outer = QVBoxLayout(self)
        outer.setContentsMargins(32, 28, 32, 28)
        outer.addWidget(TitleLabel("全局"))
        self.message = BodyLabel("" if available else "vault 未解锁，当前不可编辑。")
        outer.addWidget(self.message)
        # Use Qt's immediate wheel scrolling.  Fluent's ScrollArea installs a
        # smooth-scroll delegate, which feels delayed on this form-heavy page.
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("QScrollArea{background: transparent; border: none}")
        content = QWidget()
        content.setStyleSheet("background: transparent")
        self.content_layout = QVBoxLayout(content)
        self.content_layout.setContentsMargins(0, 8, 12, 8)
        self.content_layout.addWidget(SubtitleLabel("删除"))
        self.delete_area = QVBoxLayout()
        self.content_layout.addLayout(self.delete_area)
        add_delete = PushButton(FluentIcon.ADD, "新增删除规则")
        add_delete.setMinimumHeight(36)
        add_delete.clicked.connect(lambda: self.add_rule("delete"))
        self.content_layout.addWidget(add_delete, 0, Qt.AlignLeft)
        self.content_layout.addSpacing(12)
        self.content_layout.addWidget(SubtitleLabel("替换"))
        self.replace_area = QVBoxLayout()
        self.content_layout.addLayout(self.replace_area)
        add_replace = PushButton(FluentIcon.ADD, "新增替换规则")
        add_replace.setMinimumHeight(36)
        add_replace.clicked.connect(lambda: self.add_rule("replace"))
        self.content_layout.addWidget(add_replace, 0, Qt.AlignLeft)
        self.content_layout.addStretch(1)
        scroll.setWidget(content)
        outer.addWidget(scroll)
        self.setEnabled(available)
        self.autosave = AutoSaveController(
            executor, self.snapshot, self.write_snapshot, self.message,
            2000 if private_store.vault_mode else 1000, self)

    def showEvent(self, event):
        super().showEvent(event)
        if self.available and not self.loaded:
            self.loaded = True
            self.message.setText("正在后台加载全局规则…")
            self.executor.submit(
                lambda: self.private_store.load_global(self.config_store.load()),
                self._loaded)

    def _loaded(self, value, error):
        if error is not None:
            self.message.setText("全局规则加载失败；详情见 gui.log")
            return
        for rule in value.get("rules") or []:
            self.add_rule(rule.get("kind") or "replace", rule)
        self.autosave.seed(self.snapshot())
        self.message.setText("已载入；编辑后自动保存")

    def add_rule(self, kind, value=None):
        row = GlobalRuleRow(kind, value)
        row.remove_button.clicked.connect(lambda: self.remove_rule(row))
        (self.delete_area if kind == "delete" else self.replace_area).addWidget(row)
        self.rows.append(row)
        self.autosave.watch(row)
        if value is None:
            self.autosave.changed()

    def remove_rule(self, row):
        self.rows.remove(row)
        row.deleteLater()
        self.autosave.changed()

    def snapshot(self):
        return {"rules": [row.value() for row in self.rows]}

    def write_snapshot(self, value):
        cfg = self.config_store.load()
        value["enabled"] = bool((cfg.get("global_layer") or {}).get("enabled"))
        return self.private_store.save_global(
            self.config_store, cfg, value)
