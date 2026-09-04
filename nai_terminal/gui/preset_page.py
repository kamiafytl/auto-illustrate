from __future__ import annotations

import base64
import binascii
import uuid
from pathlib import Path

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QSize, Qt
from PySide6.QtGui import QImageReader, QPixmap
from PySide6.QtWidgets import (QDialog, QFileDialog, QFormLayout, QGridLayout,
                               QHBoxLayout, QLabel, QScrollArea, QSizePolicy,
                               QVBoxLayout, QWidget)
from qfluentwidgets import (BodyLabel, CardWidget, CheckBox, ComboBox, DoubleSpinBox,
                            FluentIcon, LineEdit, MessageBox, PillPushButton,
                            PrimaryPushButton, PushButton,
                            SubtitleLabel, SwitchButton, TextEdit, TitleLabel,
                            TransparentToolButton)

from nai_terminal.gui_store import (clone_preset, delete_preset, new_character,
                                    new_extra_block, new_preset,
                                    new_replacement_rule, role_to_char_index)
from nai_terminal.gui.autosave import AutoSaveController
from nai_terminal.gui.preset_catalog import PresetCatalog
from nai_terminal.gui.preset_catalog_model import (move_preset, rename_group,
                                                     reorder_group)
from nai_terminal.gui.preset_widgets import (RoleSelector, SectionCard, large_button,
                                              tint_card)


ROLE_OPTIONS = (("main", "主要"), ("f1", "女1"), ("f2", "女2"), ("other", "其他"))
POSITION_OPTIONS = (("前缀", "prefix"), ("后缀", "suffix"))
SCOPE_OPTIONS = (("全部", "all"), ("正向", "positive"), ("负向", "negative"))


def _combo(options, current):
    box = ComboBox()
    box.setMinimumHeight(44)
    for label, value in options:
        box.addItem(label, userData=value)
    box.setCurrentIndex(max(box.findData(current), 0))
    return box


def _text_editor(value="", height=68):
    editor = TextEdit()
    editor.setPlainText(value or "")
    editor.setFixedHeight(height)
    return editor


def _reference_image_bytes(value):
    """Decode one embedded reference without ever including it in an error string."""
    if not isinstance(value, str) or not value.strip():
        return b""
    encoded = value.strip()
    if encoded.startswith("data:") and "," in encoded:
        encoded = encoded.split(",", 1)[1]
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        return b""


def _reference_pixmap(value, edge=176):
    """Decode and downscale before painting so large source images do not stall the UI."""
    raw = _reference_image_bytes(value)
    if not raw:
        return None
    buffer = QBuffer()
    buffer.setData(QByteArray(raw))
    if not buffer.open(QIODevice.ReadOnly):
        return None
    reader = QImageReader(buffer)
    size = reader.size()
    if size.isValid():
        reader.setScaledSize(size.scaled(QSize(edge, edge), Qt.KeepAspectRatio))
    image = reader.read()
    if image.isNull():
        return None
    return QPixmap.fromImage(image)


def _connect_remove(button, callback):
    """Call ``callback()`` with no arguments when ``button`` is clicked.

    ``clicked`` carries a ``checked`` flag and Qt hands it to any callable that
    accepts one argument.  Every remove callback here is a ``lambda r=item: ...``
    bound to the row being deleted, so the flag replaced that item with ``False``
    and the delete button silently did nothing.
    """
    button.clicked.connect(lambda *_: callback())


def _confirm(parent, title, content):
    box = MessageBox(title, content, parent)
    box.yesButton.setText("确认删除")
    box.cancelButton.setText("取消")
    return bool(box.exec())


class TextPrompt(QDialog):
    """Small Fluent input dialog used for names and free-form groups."""

    def __init__(self, title, value="", placeholder="", parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setMinimumWidth(420)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.addWidget(SubtitleLabel(title))
        self.input = LineEdit()
        self.input.setText(value or "")
        self.input.setPlaceholderText(placeholder)
        self.input.selectAll()
        layout.addWidget(self.input)
        buttons = QHBoxLayout()
        buttons.addStretch(1)
        cancel = PushButton("取消")
        okay = PrimaryPushButton("确定")
        large_button(cancel)
        large_button(okay)
        cancel.clicked.connect(self.reject)
        okay.clicked.connect(self.accept)
        buttons.addWidget(cancel)
        buttons.addWidget(okay)
        layout.addLayout(buttons)

    @classmethod
    def get(cls, parent, title, value="", placeholder=""):
        dialog = cls(title, value, placeholder, parent)
        return dialog.input.text().strip() if dialog.exec() == QDialog.DialogCode.Accepted else None


class UnitProperties(QWidget):
    """Shared enabled/role/roleLabel/position editor for content units."""

    def __init__(self, value, *, position=True, role_changed=None, parent=None):
        super().__init__(parent)
        self.value = value
        self.role_changed_callback = role_changed
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)
        line = QHBoxLayout()
        line.setSpacing(8)
        self.enabled = SwitchButton()
        self.enabled.setChecked(bool(value.get("enabled", True)))
        line.addWidget(BodyLabel("启用"))
        line.addWidget(self.enabled)
        current = value.get("role") if value.get("role") in dict(ROLE_OPTIONS) else "main"
        self.role = RoleSelector(current)
        self.role.roleChanged.connect(self.set_role)
        line.addWidget(self.role)
        self.role_label = LineEdit()
        self.role_label.setPlaceholderText("特殊项名称（逐字匹配）")
        self.role_label.setText(value.get("roleLabel") or "")
        self.role_label.setMaximumWidth(210)
        self.role_label.setMinimumHeight(44)
        self.role_label.setVisible(current == "other")
        line.addWidget(self.role_label)
        self.position = _combo(POSITION_OPTIONS, value.get("position") or "prefix") if position else None
        if self.position:
            self.position.setMinimumWidth(94)
            self.position.setMinimumHeight(44)
            line.addWidget(self.position)
        line.addStretch(1)
        layout.addLayout(line)

    def set_role(self, role):
        self.value["role"] = role
        self.role_label.setVisible(role == "other")
        if self.role_changed_callback:
            self.role_changed_callback(role)

    def apply(self):
        self.value["enabled"] = self.enabled.isChecked()
        role = self.role.role()
        self.value["role"] = role
        if role == "other":
            self.value["roleLabel"] = self.role_label.text()
        if self.position:
            self.value["position"] = self.position.currentData()


class TextBlockEditor(CardWidget):
    def __init__(self, title, block, remove_callback=None, parent=None):
        super().__init__(parent)
        self.block = block
        tint_card(self, block.get("role") or "main", "textBlockCard")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 14)
        head = QHBoxLayout()
        head.addWidget(SubtitleLabel(title))
        head.addStretch(1)
        if remove_callback:
            remove = TransparentToolButton(FluentIcon.DELETE)
            remove.setFixedSize(44, 44)
            remove.setToolTip("删除此框")
            _connect_remove(remove, remove_callback)
            head.addWidget(remove)
        layout.addLayout(head)
        self.properties = UnitProperties(block, role_changed=self._role_changed)
        layout.addWidget(self.properties)
        self.text = _text_editor(block.get("text", ""))
        self.text.setPlaceholderText("隐私正文")
        layout.addWidget(self.text)

    def _role_changed(self, role):
        tint_card(self, role, "textBlockCard")

    def apply(self):
        self.properties.apply()
        self.block["text"] = self.text.toPlainText()


class CharacterEditor(CardWidget):
    def __init__(self, char, page, parent=None):
        super().__init__(parent)
        self.char = char
        self.page = page
        self.extra_editors = []
        tint_card(self, char.get("role") or "main", "characterCard")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 14)
        layout.setSpacing(9)

        head = QHBoxLayout()
        self.name = LineEdit()
        self.name.setText(char.get("name") or "")
        self.name.setPlaceholderText("角色名")
        self.name.setMinimumWidth(140)
        self.name.setMinimumHeight(44)
        head.addWidget(self.name, 1)
        remove = TransparentToolButton(FluentIcon.DELETE)
        remove.setFixedSize(44, 44)
        remove.setToolTip("删除角色")
        remove.clicked.connect(lambda: page.remove_character(char))
        head.addWidget(remove)
        layout.addLayout(head)

        self.properties = UnitProperties(char, role_changed=self._role_changed)
        layout.addWidget(self.properties)

        fields = QGridLayout()
        fields.setHorizontalSpacing(10)
        fields.setVerticalSpacing(8)
        self.text = _text_editor(char.get("text", ""))
        self.front = _text_editor(char.get("front_text", ""))
        self.negative = _text_editor(char.get("negative", ""))
        self.text.setPlaceholderText("任何视角都加入")
        self.front.setPlaceholderText("仅正面视角加入")
        self.negative.setPlaceholderText("角色负向提示词")
        fields.addWidget(self._field("全视角栏", self.text), 0, 0)
        fields.addWidget(self._field("正面栏", self.front), 0, 1)
        fields.addWidget(self._field("负向", self.negative), 1, 0, 1, 2)
        fields.setColumnStretch(0, 1)
        fields.setColumnStretch(1, 1)
        layout.addLayout(fields)

        self.extras_widget = QWidget()
        self.extras_widget.setStyleSheet("background: transparent;")
        self.extras_layout = QVBoxLayout(self.extras_widget)
        self.extras_layout.setContentsMargins(0, 0, 0, 0)
        self.extras_layout.setSpacing(7)
        for extra in char.get("extras") or []:
            if isinstance(extra, dict):
                self.add_extra_editor(extra)
        layout.addWidget(self.extras_widget)

        actions = QHBoxLayout()
        add_positive = large_button(PushButton("+ 特殊项·正向"))
        add_negative = large_button(PushButton("+ 特殊项·负向"))
        add_positive.clicked.connect(lambda: page.add_character_extra(char, "positive"))
        add_negative.clicked.connect(lambda: page.add_character_extra(char, "negative"))
        actions.addWidget(add_positive)
        actions.addWidget(add_negative)
        actions.addStretch(1)
        layout.addLayout(actions)

    @staticmethod
    def _field(label, editor):
        field = QWidget()
        field.setStyleSheet("background: transparent;")
        layout = QVBoxLayout(field)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        title = BodyLabel(label)
        title.setStyleSheet("font-weight: 700;")
        layout.addWidget(title)
        layout.addWidget(editor)
        return field

    def add_extra_editor(self, extra):
        label = "特殊项·负向" if extra.get("kind") == "negative" else "特殊项·正向"
        editor = TextBlockEditor(
            label, extra, lambda e=extra: self.page.remove_character_extra(self.char, e))
        self.extra_editors.append(editor)
        self.extras_layout.addWidget(editor)
        return editor

    def remove_extra_editor(self, extra):
        editor = next((e for e in self.extra_editors if e.block is extra), None)
        if not editor:
            return
        self.extra_editors.remove(editor)
        self.extras_layout.removeWidget(editor)
        editor.deleteLater()

    def _role_changed(self, role):
        self.char["char_index"] = role_to_char_index(role)
        tint_card(self, role, "characterCard")

    def apply(self):
        self.properties.apply()
        self.char["name"] = self.name.text()
        self.char["text"] = self.text.toPlainText()
        self.char["front_text"] = self.front.toPlainText()
        self.char["negative"] = self.negative.toPlainText()
        for editor in self.extra_editors:
            editor.apply()


class ReplacementEditor(CardWidget):
    def __init__(self, rule, remove_callback, parent=None):
        super().__init__(parent)
        self.rule = rule
        tint_card(self, rule.get("role") or "main", "replacementCard")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 14)
        head = QHBoxLayout()
        head.addWidget(SubtitleLabel("关键词规则"))
        head.addStretch(1)
        remove = TransparentToolButton(FluentIcon.DELETE)
        remove.setFixedSize(44, 44)
        _connect_remove(remove, remove_callback)
        head.addWidget(remove)
        layout.addLayout(head)
        properties = QHBoxLayout()
        self.common = UnitProperties(rule, position=False, role_changed=self._role_changed)
        properties.addWidget(self.common, 1)
        self.whole_word = CheckBox("整词匹配")
        self.whole_word.setMinimumHeight(44)
        self.whole_word.setChecked(bool(rule.get("wholeWord", True)))
        properties.addWidget(self.whole_word)
        layout.addLayout(properties)
        form = QFormLayout()
        self.kind = _combo((("替换", "replace"), ("删除", "delete")), rule.get("kind") or "replace")
        self.scope = _combo(SCOPE_OPTIONS, rule.get("scope") or "all")
        self.source = LineEdit()
        self.source.setText(rule.get("word", rule.get("from", "")) or "")
        self.target = LineEdit()
        self.target.setText(rule.get("to", "") or "")
        form.addRow(BodyLabel("类型："), self.kind)
        form.addRow(BodyLabel("作用范围："), self.scope)
        form.addRow(BodyLabel("原词/删除词："), self.source)
        form.addRow(BodyLabel("替换为："), self.target)
        layout.addLayout(form)

    def _role_changed(self, role):
        tint_card(self, role, "replacementCard")

    def apply(self):
        self.common.apply()
        kind = self.kind.currentData()
        self.rule["wholeWord"] = self.whole_word.isChecked()
        self.rule["kind"], self.rule["scope"] = kind, self.scope.currentData()
        if kind == "delete":
            self.rule["word"] = self.source.text()
            self.rule["from"] = self.source.text()
            self.rule["to"] = ""
        else:
            self.rule.pop("word", None)
            self.rule["from"], self.rule["to"] = self.source.text(), self.target.text()


class ReferenceEditor(CardWidget):
    def __init__(self, ref, remove_callback, source_path=None, parent=None):
        super().__init__(parent)
        self.ref = ref
        self.source_path = str(source_path or ref.get("source_path") or "")
        tint_card(self, ref.get("role") or "main", "referenceCard")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 14)
        head = QHBoxLayout()
        head.addWidget(SubtitleLabel("角色参考"))
        head.addStretch(1)
        remove = TransparentToolButton(FluentIcon.DELETE)
        remove.setFixedSize(44, 44)
        _connect_remove(remove, remove_callback)
        head.addWidget(remove)
        layout.addLayout(head)
        self.common = UnitProperties(ref, position=False, role_changed=self._role_changed)
        layout.addWidget(self.common)

        image_row = QHBoxLayout()
        image_row.setSpacing(16)
        self.preview = QLabel()
        self.preview.setObjectName("referencePreview")
        self.preview.setFixedSize(184, 184)
        self.preview.setAlignment(Qt.AlignCenter)
        self.preview.setStyleSheet(
            "QLabel#referencePreview { background: rgba(127,127,127,0.12); "
            "border: 1px solid rgba(127,127,127,0.35); border-radius: 8px; }")
        pixmap = _reference_pixmap(ref.get("image_b64"), 176)
        if pixmap is None:
            self.preview.setText("尚未导入图片" if not ref.get("image_b64") else
                                 "图片损坏或格式不支持")
        else:
            self.preview.setPixmap(pixmap)
        image_row.addWidget(self.preview, 0, Qt.AlignTop)

        details = QVBoxLayout()
        details.setSpacing(7)
        file_name = str(ref.get("fileName") or
                        (Path(self.source_path).name if self.source_path else "") or
                        "未记录文件名")
        self.file_name = BodyLabel(f"文件名：{file_name}")
        self.file_name.setWordWrap(True)
        self.file_name.setTextInteractionFlags(Qt.TextSelectableByMouse)
        details.addWidget(self.file_name)
        if self.source_path:
            path_text = self.source_path
        else:
            path_text = "旧数据未记录原始路径（图片仍保存在终端私库）"
        self.file_path = BodyLabel(f"路径：{path_text}")
        self.file_path.setWordWrap(True)
        self.file_path.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.file_path.setToolTip(path_text)
        details.addWidget(self.file_path)
        status = "预览正常" if pixmap is not None else (
            "尚未导入图片" if not ref.get("image_b64") else "无法预览，请重新导入")
        self.image_status = BodyLabel(f"状态：{status}")
        details.addWidget(self.image_status)
        details.addStretch(1)
        image_row.addLayout(details, 1)
        layout.addLayout(image_row)

        form = QFormLayout()
        self.side = _combo((("正面", "front"), ("背面", "back")), ref.get("side") or "front")
        self.strength = DoubleSpinBox()
        self.strength.setRange(0.0, 1.0)
        self.strength.setSingleStep(0.05)
        self.strength.setValue(float(ref.get("strength", 1.0)))
        self.fidelity = DoubleSpinBox()
        self.fidelity.setRange(0.0, 1.0)
        self.fidelity.setSingleStep(0.05)
        self.fidelity.setValue(float(ref.get("fidelity", 1.0)))
        form.addRow(BodyLabel("方向："), self.side)
        form.addRow(BodyLabel("强度："), self.strength)
        form.addRow(BodyLabel("保真度："), self.fidelity)
        layout.addLayout(form)

    def _role_changed(self, role):
        tint_card(self, role, "referenceCard")

    def apply(self):
        self.common.apply()
        self.ref["side"] = self.side.currentData()
        self.ref["strength"], self.ref["fidelity"] = self.strength.value(), self.fidelity.value()


class PresetPage(QWidget):
    def __init__(self, config_store, private_store, executor, available=True, parent=None):
        super().__init__(parent)
        self.setObjectName("presetPage")
        self.config_store = config_store
        self.private_store = private_store
        self.executor = executor
        self.available = available
        self._requested_preset = None
        self._switching = False
        self.current = None
        self._catalog_presets = []
        self._active_id = None
        self._editor_widget = None
        self._wide_sections = None
        self.char_editors = []
        self.block_editors = []
        self.replacement_editors = []
        self.reference_editors = []
        outer = QVBoxLayout(self)
        outer.setContentsMargins(32, 24, 32, 24)
        outer.setSpacing(8)
        outer.addWidget(TitleLabel("单独预设"))
        self.message = BodyLabel("" if available else "vault 未解锁，当前不可编辑。")
        self.message.setWordWrap(True)
        outer.addWidget(self.message)

        # Use Qt's immediate scroll area here. qfluentwidgets.ScrollArea adds a
        # smooth-scroll delegate, which made wheel input feel delayed and inertial.
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.scroll.setStyleSheet("QScrollArea{background: transparent; border: none}")
        self.page_content = QWidget()
        self.page_content.setStyleSheet("background: transparent")
        self.page_content.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
        self.page_layout = QVBoxLayout(self.page_content)
        self.page_layout.setContentsMargins(0, 8, 12, 12)
        self.page_layout.setSpacing(12)

        self.toolbar = CardWidget()
        toolbar_layout = QHBoxLayout(self.toolbar)
        toolbar_layout.setContentsMargins(14, 10, 14, 10)
        toolbar_layout.setSpacing(8)
        for text, slot in (("新建空白", self.create_blank), ("+ 新建（克隆当前）", self.clone_current),
                           ("删除", self.delete_current), ("重命名", self.rename_current),
                           ("改分组", self.group_current), ("设为当前", self.make_active)):
            button = PillPushButton(text)
            button.setMinimumHeight(44)
            button.setMinimumWidth(90)
            button.clicked.connect(slot)
            toolbar_layout.addWidget(button)
        toolbar_layout.addStretch(1)
        self.page_layout.addWidget(self.toolbar)

        catalog_title = BodyLabel("预设文件夹 · 拖动文件夹或胶囊排序，点击文件夹标题可改名")
        catalog_title.setStyleSheet("font-size: 14px; font-weight: 700;")
        self.page_layout.addWidget(catalog_title)
        self.catalog = PresetCatalog()
        self.catalog.presetActivated.connect(lambda pid: self.select_preset(pid, make_active=True))
        self.catalog.renameGroupRequested.connect(self.rename_folder)
        self.catalog.groupReordered.connect(self.reorder_folder)
        self.catalog.presetMoved.connect(self.move_catalog_preset)
        self.page_layout.addWidget(self.catalog)

        self.editor_host = QWidget()
        self.editor_host.setStyleSheet("background: transparent")
        self.editor_host_layout = QVBoxLayout(self.editor_host)
        self.editor_host_layout.setContentsMargins(0, 0, 0, 0)
        self.page_layout.addWidget(self.editor_host)
        self.page_layout.addStretch(1)
        self.scroll.setWidget(self.page_content)
        outer.addWidget(self.scroll, 1)
        self.setEnabled(available)
        self.autosave = AutoSaveController(
            executor, self.snapshot, self.write_snapshot, self.message,
            2000 if private_store.vault_mode else 1000, self)
        if available:
            self.reload_catalog()

    def showEvent(self, event):
        super().showEvent(event)
        if self.available and self.current is None:
            self.select_preset(self._active_id, make_active=False)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._arrange_sections()

    def reload_catalog(self, select_id=None):
        cfg = self.config_store.load()
        store = cfg.get("augmentation_presets") or {}
        self._catalog_presets = [p for p in (store.get("presets") or [])
                                 if isinstance(p, dict)]
        self._active_id = store.get("activeId")
        self._refresh_catalog()
        wanted = select_id or self._active_id
        should_load = select_id is not None or self.isVisible()
        if wanted and should_load and (not self.current or self.current.get("id") != wanted):
            self.select_preset(wanted, make_active=False)
        elif not self._catalog_presets:
            self.current = None
            self._clear_editor()

    def _display_presets(self):
        display = []
        current_id = str((self.current or {}).get("id") or "")
        for preset in self._catalog_presets:
            shown = dict(preset)
            if str(shown.get("id") or "") == current_id:
                for key in ("name", "group", "enabled"):
                    if key in self.current:
                        shown[key] = self.current[key]
            display.append(shown)
        return display

    def _refresh_catalog(self):
        self.catalog.set_presets(self._display_presets(), self._active_id)

    def _set_switching(self, switching):
        """Freeze old-content mutations while still allowing a newer capsule choice."""
        self._switching = bool(switching)
        enabled = not self._switching
        self.toolbar.setEnabled(enabled)
        self.editor_host.setEnabled(enabled)

    def _persist_active(self, preset_id, callback):
        """Persist the current marker only after the previous preset saved safely."""
        def write_active():
            cfg = self.config_store.load()
            cfg.setdefault("augmentation_presets", {})["activeId"] = preset_id
            self.config_store.save(cfg)

        def done(_result, error):
            if error is None and preset_id == self._requested_preset:
                self._active_id = preset_id
                self._refresh_catalog()
            callback(error)

        self.executor.submit(write_active, done)

    def select_preset(self, preset_id=None, *, make_active=True):
        preset_id = str(preset_id or self._active_id or "")
        if not preset_id:
            return
        current_id = str((self.current or {}).get("id") or "")
        self._requested_preset = preset_id
        if current_id == preset_id and not self._switching:
            if make_active and preset_id != str(self._active_id or ""):
                self._set_switching(True)

                def activate_after_save(save_error):
                    if preset_id != self._requested_preset:
                        return
                    if save_error is not None:
                        self._set_switching(False)
                        self.message.setText("当前预设保存失败，未更改当前标记；详情见 gui.log")
                        return

                    def activated(error):
                        if preset_id != self._requested_preset:
                            return
                        self._set_switching(False)
                        self.message.setText(
                            "已设为当前预设。" if error is None else
                            "设置当前预设失败；详情见 gui.log")

                    self._persist_active(preset_id, activated)

                self.autosave.flush_then(activate_after_save)
                return
            self._refresh_catalog()
            return

        # This also cancels an in-progress request if the user asks to remain on
        # the editor that is still on screen.  Any already-frozen save may finish.
        if current_id == preset_id:
            self._set_switching(False)
            self._refresh_catalog()
            return

        self._set_switching(True)
        self.message.setText("正在保存当前修改并切换…" if self.current else "正在后台加载预设…")

        def loaded(value, error):
            if preset_id != self._requested_preset:
                return
            if error is not None:
                self._set_switching(False)
                self.message.setText("预设加载失败；详情见 gui.log")
                return
            self.current = value
            self.build_editor()
            self.autosave.seed()
            self._refresh_catalog()
            if not make_active or preset_id == str(self._active_id or ""):
                self._set_switching(False)
                self.message.setText("已载入；编辑后自动保存")
                return

            self.message.setText("已载入，正在设置当前预设…")

            def activated(active_error):
                if preset_id != self._requested_preset:
                    return
                self._set_switching(False)
                self.message.setText(
                    "已载入；编辑后自动保存" if active_error is None else
                    "预设已载入，但当前标记保存失败；详情见 gui.log")

            self._persist_active(preset_id, activated)

        def begin_load(save_error):
            if preset_id != self._requested_preset:
                return
            if save_error is not None:
                self._set_switching(False)
                self.message.setText("当前预设保存失败，已停止切换；详情见 gui.log")
                return
            self.message.setText("正在后台加载预设…")
            self.executor.submit(
                lambda: self.private_store.load_preset(self.config_store.load(), preset_id),
                loaded)

        if self.current:
            self.autosave.flush_then(begin_load)
        else:
            begin_load(None)

    def _persist_catalog_change(self, transform, optimistic, success_text):
        self._catalog_presets = optimistic
        self._refresh_catalog()
        self.message.setText("正在保存预设排列…")

        def write():
            cfg = self.config_store.load()
            store = cfg.setdefault("augmentation_presets", {})
            store["presets"] = transform(store.get("presets") or [])
            self.config_store.save(cfg)
            return cfg

        def done(cfg, error):
            if error is not None:
                self.message.setText("预设排列保存失败；详情见 gui.log")
                self.reload_catalog()
                return
            store = (cfg or {}).get("augmentation_presets") or {}
            self._catalog_presets = [p for p in (store.get("presets") or [])
                                     if isinstance(p, dict)]
            self._active_id = store.get("activeId")
            self._refresh_catalog()
            self.message.setText(success_text)

        self.executor.submit(write, done)

    def rename_folder(self, old_name):
        value = TextPrompt.get(self, "重命名预设文件夹", old_name,
                               "留空表示未分组；同名会合并")
        if value is None or value == old_name:
            return
        if self.current and str(self.current.get("group") or "") == str(old_name or ""):
            self.flush()
            self.current["group"] = value
            self.autosave.changed()
        transform = lambda items: rename_group(items, old_name, value)
        self._persist_catalog_change(transform, transform(self._catalog_presets), "文件夹已重命名")

    def reorder_folder(self, moved_group, before_group):
        transform = lambda items: reorder_group(items, moved_group, before_group)
        self._persist_catalog_change(transform, transform(self._catalog_presets), "文件夹顺序已保存")

    def move_catalog_preset(self, preset_id, target_group, before_id=None):
        if self.current and str(self.current.get("id") or "") == str(preset_id):
            self.flush()
            self.current["group"] = target_group
            self.autosave.changed()
        transform = lambda items: move_preset(items, preset_id, target_group, before_id)
        self._persist_catalog_change(transform, transform(self._catalog_presets), "预设位置已保存")

    def build_editor(self):
        self._clear_editor()
        content = QWidget()
        content.setStyleSheet("background: transparent")
        layout = QVBoxLayout(content)
        layout.setContentsMargins(0, 4, 0, 8)
        layout.setSpacing(12)
        head = CardWidget()
        head_layout = QHBoxLayout(head)
        head_layout.setContentsMargins(16, 12, 16, 12)
        self.editor_title = SubtitleLabel(self.current.get("name") or self.current.get("id") or "预设")
        head_layout.addWidget(self.editor_title)
        head_layout.addStretch(1)
        head_layout.addWidget(BodyLabel("启用此预设"))
        self.enabled = SwitchButton()
        self.enabled.setChecked(bool(self.current.get("enabled", True)))
        self.enabled.checkedChanged.connect(self._enabled_changed)
        head_layout.addWidget(self.enabled)
        layout.addWidget(head)

        self.section_grid = QGridLayout()
        self.section_grid.setContentsMargins(0, 0, 0, 0)
        self.section_grid.setHorizontalSpacing(12)
        self.section_grid.setVerticalSpacing(12)

        self.character_section = SectionCard(
            "①", "角色加装", "角色全视角 / 正面 / 负向；特殊项按公开名称逐字匹配")
        self.char_empty = BodyLabel("暂无角色，点击下方“增加角色”")
        self.char_empty.setVisible(not bool(self.current.get("chars")))
        self.character_section.body.addWidget(self.char_empty)
        self.char_list_widget = QWidget()
        self.char_list_widget.setStyleSheet("background: transparent")
        self.char_list_layout = QVBoxLayout(self.char_list_widget)
        self.char_list_layout.setContentsMargins(0, 0, 0, 0)
        self.char_list_layout.setSpacing(10)
        self.char_editors = []
        for char in self.current.get("chars") or []:
            if isinstance(char, dict):
                editor = CharacterEditor(char, self)
                self.char_editors.append(editor)
                self.char_list_layout.addWidget(editor)
        self.character_section.body.addWidget(self.char_list_widget)
        self.add_char_button = large_button(PushButton(FluentIcon.ADD, "+ 增加角色"))
        self.add_char_button.clicked.connect(self.add_character)
        self.character_section.body.addWidget(self.add_char_button, 0, Qt.AlignLeft)

        self.prompt_section = SectionCard(
            "②", "提示词加装", "基础正负向与额外框；归属颜色与角色卡保持一致")
        self.prompt_list_widget = QWidget()
        self.prompt_list_widget.setStyleSheet("background: transparent")
        self.prompt_list_layout = QVBoxLayout(self.prompt_list_widget)
        self.prompt_list_layout.setContentsMargins(0, 0, 0, 0)
        self.prompt_list_layout.setSpacing(9)
        self.block_editors = []
        for key, title in (("base_positive", "基础正向"), ("base_negative", "基础负向")):
            block = self.current.get(key)
            if isinstance(block, dict):
                editor = TextBlockEditor(title, block)
                self.block_editors.append(editor)
                self.prompt_list_layout.addWidget(editor)
        for block in self.current.get("extra_blocks") or []:
            if isinstance(block, dict):
                title = "负面追加框" if block.get("kind") == "negative" else "正面追加框"
                editor = TextBlockEditor(title, block, lambda b=block: self.remove_extra(b))
                self.block_editors.append(editor)
                self.prompt_list_layout.addWidget(editor)
        self.prompt_section.body.addWidget(self.prompt_list_widget)
        extra_actions = QHBoxLayout()
        add_pos = large_button(PushButton("+ 加正面框"))
        add_neg = large_button(PushButton("+ 加负面框"))
        add_pos.clicked.connect(lambda: self.add_extra("positive"))
        add_neg.clicked.connect(lambda: self.add_extra("negative"))
        extra_actions.addWidget(add_pos)
        extra_actions.addWidget(add_neg)
        extra_actions.addStretch(1)
        self.prompt_section.body.addLayout(extra_actions)

        self.replacement_section = SectionCard(
            "③", "关键词删除与替换", "作用于全部 / 正向 / 负向；不区分基础与角色区块")
        replacement_head = QHBoxLayout()
        replacement_head.addStretch(1)
        replacement_head.addWidget(BodyLabel("启用替换"))
        self.replacements_enabled = SwitchButton()
        replacements = self.current.setdefault("replacements", {"enabled": True, "rules": []})
        self.replacements_enabled.setChecked(bool(replacements.get("enabled", True)))
        replacement_head.addWidget(self.replacements_enabled)
        self.replacement_section.body.addLayout(replacement_head)
        self.replacement_list_widget = QWidget()
        self.replacement_list_widget.setStyleSheet("background: transparent")
        self.replacement_list_layout = QVBoxLayout(self.replacement_list_widget)
        self.replacement_list_layout.setContentsMargins(0, 0, 0, 0)
        self.replacement_list_layout.setSpacing(9)
        self.replacement_editors = []
        for rule in replacements.get("rules") or []:
            if isinstance(rule, dict):
                editor = ReplacementEditor(rule, lambda r=rule: self.remove_replacement(r))
                self.replacement_editors.append(editor)
                self.replacement_list_layout.addWidget(editor)
        self.replacement_section.body.addWidget(self.replacement_list_widget)
        self.add_rule_button = large_button(PushButton(FluentIcon.ADD, "+ 新增规则"))
        self.add_rule_button.clicked.connect(self.add_replacement)
        self.replacement_section.body.addWidget(self.add_rule_button, 0, Qt.AlignLeft)

        self.reference_section = SectionCard(
            "④", "角色参考", "参考图、文件名与路径留在终端私库，不进入公开配置或日志")
        self.reference_list_widget = QWidget()
        self.reference_list_widget.setStyleSheet("background: transparent")
        self.reference_list_layout = QVBoxLayout(self.reference_list_widget)
        self.reference_list_layout.setContentsMargins(0, 0, 0, 0)
        self.reference_list_layout.setSpacing(9)
        self.reference_editors = []
        for ref in self.current.get("char_references") or []:
            if isinstance(ref, dict):
                editor = ReferenceEditor(ref, lambda r=ref: self.remove_reference(r))
                self.reference_editors.append(editor)
                self.reference_list_layout.addWidget(editor)
        self.reference_section.body.addWidget(self.reference_list_widget)
        self.import_button = large_button(PushButton(FluentIcon.PHOTO, "导入角色参考图片"))
        self.import_button.clicked.connect(self.import_reference)
        self.reference_section.body.addWidget(self.import_button, 0, Qt.AlignLeft)

        layout.addLayout(self.section_grid)
        layout.addStretch(1)
        self._editor_widget = content
        self.editor_host_layout.addWidget(content)
        self._wide_sections = None
        self._arrange_sections()
        self.autosave.watch(content)

    def _clear_editor(self):
        if not self._editor_widget:
            return
        self.editor_host_layout.removeWidget(self._editor_widget)
        self._editor_widget.deleteLater()
        self._editor_widget = None
        self.section_grid = None

    def _arrange_sections(self):
        grid = getattr(self, "section_grid", None)
        if not grid:
            return
        # Each half needs enough room for the four role capsules and position
        # controls.  Below this width stacking avoids the clipped right column
        # that the old splitter created.
        wide = self.width() >= 1200
        if wide == self._wide_sections:
            return
        while grid.count():
            grid.takeAt(0)
        if wide:
            grid.addWidget(self.character_section, 0, 0)
            grid.addWidget(self.prompt_section, 0, 1)
            grid.addWidget(self.replacement_section, 1, 0, 1, 2)
            grid.addWidget(self.reference_section, 2, 0, 1, 2)
            grid.setColumnStretch(0, 1)
            grid.setColumnStretch(1, 1)
        else:
            grid.addWidget(self.character_section, 0, 0)
            grid.addWidget(self.prompt_section, 1, 0)
            grid.addWidget(self.replacement_section, 2, 0)
            grid.addWidget(self.reference_section, 3, 0)
            grid.setColumnStretch(0, 1)
        self._wide_sections = wide

    def _enabled_changed(self, enabled):
        if self.current:
            self.current["enabled"] = bool(enabled)
            self._refresh_catalog()

    def flush(self):
        if not self.current:
            return
        self.current["enabled"] = self.enabled.isChecked()
        self.current.setdefault("replacements", {})["enabled"] = self.replacements_enabled.isChecked()
        for editor in (self.char_editors + self.block_editors +
                       self.replacement_editors + self.reference_editors):
            editor.apply()

    def _watch_new(self, widget):
        self.autosave.watch(widget)
        self.autosave.changed()

    def add_character(self):
        self.flush()
        char = new_character(len(self.current.get("chars") or []) + 1)
        self.current.setdefault("chars", []).append(char)
        editor = CharacterEditor(char, self)
        self.char_editors.append(editor)
        self.char_list_layout.addWidget(editor)
        self.char_empty.hide()
        self._watch_new(editor)

    def remove_character(self, char):
        if _confirm(self, "删除角色", f"删除角色「{char.get('name') or '未命名'}」及其效果框？"):
            self.flush()
            editor = next((e for e in self.char_editors if e.char is char), None)
            self.current["chars"].remove(char)
            if editor:
                self.char_editors.remove(editor)
                self.char_list_layout.removeWidget(editor)
                editor.deleteLater()
            self.char_empty.setVisible(not bool(self.char_editors))
            self.autosave.changed()

    def add_character_extra(self, char, kind):
        editor = next((e for e in self.char_editors if e.char is char), None)
        if editor:
            editor.apply()
        extra = new_extra_block(kind)
        char.setdefault("extras", []).append(extra)
        if editor:
            self._watch_new(editor.add_extra_editor(extra))
        else:
            self.autosave.changed()

    def remove_character_extra(self, char, extra):
        editor = next((e for e in self.char_editors if e.char is char), None)
        if editor:
            editor.apply()
        if extra in (char.get("extras") or []):
            char["extras"].remove(extra)
        if editor:
            editor.remove_extra_editor(extra)
        self.autosave.changed()

    def add_extra(self, kind):
        self.flush()
        block = new_extra_block(kind)
        self.current.setdefault("extra_blocks", []).append(block)
        title = "负面追加框" if kind == "negative" else "正面追加框"
        editor = TextBlockEditor(title, block, lambda b=block: self.remove_extra(b))
        self.block_editors.append(editor)
        self.prompt_list_layout.addWidget(editor)
        self._watch_new(editor)

    def remove_extra(self, block):
        self.flush()
        editor = next((e for e in self.block_editors if e.block is block), None)
        if block in (self.current.get("extra_blocks") or []):
            self.current["extra_blocks"].remove(block)
        if editor:
            self.block_editors.remove(editor)
            self.prompt_list_layout.removeWidget(editor)
            editor.deleteLater()
        self.autosave.changed()

    def add_replacement(self):
        self.flush()
        rule = new_replacement_rule()
        self.current["replacements"].setdefault("rules", []).append(rule)
        editor = ReplacementEditor(rule, lambda r=rule: self.remove_replacement(r))
        self.replacement_editors.append(editor)
        self.replacement_list_layout.addWidget(editor)
        self._watch_new(editor)

    def remove_replacement(self, rule):
        self.flush()
        editor = next((e for e in self.replacement_editors if e.rule is rule), None)
        if rule in (self.current.get("replacements", {}).get("rules") or []):
            self.current["replacements"]["rules"].remove(rule)
        if editor:
            self.replacement_editors.remove(editor)
            self.replacement_list_layout.removeWidget(editor)
            editor.deleteLater()
        self.autosave.changed()

    def remove_reference(self, ref):
        self.flush()
        editor = next((e for e in self.reference_editors if e.ref is ref), None)
        if ref in (self.current.get("char_references") or []):
            self.current["char_references"].remove(ref)
        if editor:
            self.reference_editors.remove(editor)
            self.reference_list_layout.removeWidget(editor)
            editor.deleteLater()
        self.autosave.changed()

    def import_reference(self):
        path, _ = QFileDialog.getOpenFileName(self, "导入角色参考图片", "",
                                              "图片文件 (*.png *.jpg *.jpeg *.webp)")
        if not path:
            return
        try:
            encoded = base64.b64encode(Path(path).read_bytes()).decode("ascii")
        except OSError:
            self.message.setText("图片无法读取，可能已移动或当前账户没有权限。")
            return
        if _reference_pixmap(encoded) is None:
            self.message.setText("图片损坏或格式不受支持，请重新选择 PNG、JPG 或 WebP 图片。")
            return
        ref = {"id": f"cr_{uuid.uuid4().hex[:12]}", "enabled": True, "isPrivate": True,
               "image_b64": encoded, "side": "front", "strength": 1.0, "fidelity": 1.0,
               "role": "main", "fileName": Path(path).name, "source_path": path}
        self.flush()
        self.current.setdefault("char_references", []).append(ref)
        editor = ReferenceEditor(ref, lambda r=ref: self.remove_reference(r))
        self.reference_editors.append(editor)
        self.reference_list_layout.addWidget(editor)
        self._watch_new(editor)
        self.message.setText(
            "图片预览已更新；图片、文件名和原始路径保存到终端私库，不写入公开配置或日志。")

    def snapshot(self):
        if not self.current:
            return {}
        self.flush()
        return self.current

    def write_snapshot(self, value):
        return self.private_store.save_preset(
            self.config_store, self.config_store.load(), value)

    def create_blank(self):
        preset = new_preset(f"预设{len((self.config_store.load().get('augmentation_presets') or {}).get('presets') or []) + 1}")
        self._set_switching(True)
        self.message.setText("正在保存当前修改并创建预设…")

        def write():
            cfg = self.private_store.save_preset(self.config_store, self.config_store.load(), preset)
            cfg["augmentation_presets"]["activeId"] = preset["id"]
            self.config_store.save(cfg)

        def created(_result, error):
            if error is None:
                self.reload_catalog(preset["id"])
            else:
                self._set_switching(False)
                self.message.setText("创建失败；详情见 gui.log")

        def after_save(error):
            if error is not None:
                self._set_switching(False)
                self.message.setText("当前预设保存失败，已停止创建；详情见 gui.log")
                return
            self.message.setText("正在创建预设…")
            self.executor.submit(write, created)

        self.autosave.flush_then(after_save) if self.current else after_save(None)

    def clone_current(self):
        if not self.current:
            return
        self.flush()
        cloned = clone_preset(self.current)
        self._set_switching(True)
        self.message.setText("正在保存当前修改并克隆预设…")

        def write():
            cfg = self.private_store.save_preset(self.config_store, self.config_store.load(), cloned)
            cfg["augmentation_presets"]["activeId"] = cloned["id"]
            self.config_store.save(cfg)

        def cloned_done(_result, error):
            if error is None:
                self.reload_catalog(cloned["id"])
            else:
                self._set_switching(False)
                self.message.setText("克隆失败；详情见 gui.log")

        def after_save(error):
            if error is not None:
                self._set_switching(False)
                self.message.setText("当前预设保存失败，已停止克隆；详情见 gui.log")
                return
            self.message.setText("正在克隆预设…")
            self.executor.submit(write, cloned_done)

        self.autosave.flush_then(after_save)

    def delete_current(self):
        if not self.current:
            return
        name, pid = self.current.get("name") or "未命名", self.current.get("id")
        if not _confirm(self, "删除预设", f"删除预设「{name}」？此操作不可撤销。"):
            return
        self.autosave.cancel_pending()
        self.message.setText("正在删除预设…")
        self.executor.submit(
            lambda: delete_preset(self.config_store, self.config_store.load(), pid,
                                  self.private_store),
            lambda cfg, error: (self.reload_catalog(
                (cfg.get("augmentation_presets") or {}).get("activeId"))
                if error is None else self.message.setText("删除失败；详情见 gui.log")))

    def rename_current(self):
        if not self.current:
            return
        value = TextPrompt.get(self, "重命名预设", self.current.get("name") or "")
        if value:
            self.flush()
            self.current["name"] = value
            self.editor_title.setText(value)
            self._refresh_catalog()
            self.autosave.changed()

    def group_current(self):
        if not self.current:
            return
        value = TextPrompt.get(self, "修改预设分组", self.current.get("group") or "",
                               "留空表示未分组")
        if value is not None and value != str(self.current.get("group") or ""):
            self.move_catalog_preset(self.current.get("id"), value, None)

    def make_active(self):
        if not self.current:
            return
        self.autosave.save_now()
        self.select_preset(self.current.get("id"), make_active=True)
