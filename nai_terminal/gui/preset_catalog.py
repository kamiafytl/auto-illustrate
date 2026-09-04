"""Colourful folder/capsule picker for terminal augmentation presets."""
from __future__ import annotations

from PySide6.QtCore import QEvent, QMimeData, QPoint, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QDrag, QMouseEvent
from PySide6.QtWidgets import (QAbstractScrollArea, QApplication, QGridLayout,
                               QHBoxLayout, QLabel, QLayout, QPushButton,
                               QSizePolicy, QVBoxLayout, QWidget)
from qfluentwidgets import BodyLabel, CardWidget, FlowLayout, isDarkTheme, qconfig

from nai_terminal.gui.preset_catalog_model import grouped_presets


PRESET_MIME = "application/x-owner-nai-preset"
GROUP_MIME = "application/x-owner-nai-preset-group"
LIGHT_GROUP_COLORS = (
    ("#7561a8", "rgba(117, 97, 168, 0.09)"),
    ("#a85f7a", "rgba(168, 95, 122, 0.08)"),
    ("#527f91", "rgba(82, 127, 145, 0.08)"),
    ("#9b7559", "rgba(155, 117, 89, 0.08)"),
    ("#568477", "rgba(86, 132, 119, 0.08)"),
    ("#8e7b4f", "rgba(142, 123, 79, 0.08)"),
    ("#796b99", "rgba(121, 107, 153, 0.08)"),
    ("#527f79", "rgba(82, 127, 121, 0.08)"),
)

# Muted accents for lights-off use.  These avoid the neon borders of the web
# palette while retaining enough colour to distinguish folders at a glance.
DARK_GROUP_COLORS = (
    ("#9185ad", "rgba(145, 133, 173, 0.10)"),
    ("#ad7f91", "rgba(173, 127, 145, 0.09)"),
    ("#7395a1", "rgba(115, 149, 161, 0.09)"),
    ("#a48770", "rgba(164, 135, 112, 0.09)"),
    ("#75978d", "rgba(117, 151, 141, 0.09)"),
    ("#9f906a", "rgba(159, 144, 106, 0.09)"),
    ("#8c82a3", "rgba(140, 130, 163, 0.09)"),
    ("#71928d", "rgba(113, 146, 141, 0.09)"),
)


def group_colors():
    return DARK_GROUP_COLORS if isDarkTheme() else LIGHT_GROUP_COLORS


class _DragSource:
    drag_mime = ""
    drag_payload = ""

    def _drag_press(self, event: QMouseEvent):
        self._drag_start = event.position().toPoint() if event.button() == Qt.LeftButton else None

    def _drag_move(self, event: QMouseEvent):
        start = getattr(self, "_drag_start", None)
        if start is None or not (event.buttons() & Qt.LeftButton):
            return False
        if (event.position().toPoint() - start).manhattanLength() < QApplication.startDragDistance():
            return False
        mime = QMimeData()
        mime.setData(self.drag_mime, self.drag_payload.encode("utf-8"))
        drag = QDrag(self)
        drag.setMimeData(mime)
        try:
            drag.setPixmap(self.grab())
        except Exception:
            pass
        drag.exec(Qt.MoveAction)
        self._drag_start = None
        return True


class DragHandle(QLabel, _DragSource):
    def __init__(self, group_name: str, parent=None):
        super().__init__("拖动", parent)
        self.drag_mime = GROUP_MIME
        self.drag_payload = group_name
        self.setCursor(Qt.OpenHandCursor)
        self.setToolTip("拖动文件夹排序")
        self.setMinimumWidth(38)
        self.setMinimumHeight(44)
        self.setStyleSheet("font-size: 12px; font-weight: 700; color: rgba(128,128,128,.85);")

    def mousePressEvent(self, event):
        self._drag_press(event)
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if not self._drag_move(event):
            super().mouseMoveEvent(event)


class PresetChip(QPushButton, _DragSource):
    activated = Signal(str)

    def __init__(self, preset: dict, active: bool, accent: str, parent=None):
        super().__init__(parent)
        self.preset_id = str(preset.get("id") or "")
        self.drag_mime = PRESET_MIME
        self.drag_payload = self.preset_id
        self.setCursor(Qt.OpenHandCursor)
        self.setMinimumHeight(44)
        self.clicked.connect(lambda: self.activated.emit(self.preset_id))
        self.update_preset(preset, active, accent)

    def update_preset(self, preset: dict, active: bool, accent: str):
        """Update one capsule in place instead of destroying the catalog."""
        self._preset = preset
        self._active = bool(active)
        name = str(preset.get("name") or preset.get("id") or "未命名")
        enabled = preset.get("enabled") is not False
        label = ("当前 · " if active else "") + name
        if not enabled:
            label += " · 停用"
        self.setText(label)
        self.setToolTip(f"{name} · 点击选中，拖动排序或换文件夹")
        if active:
            background, foreground, border = accent, "white", accent
        elif enabled:
            background = "rgba(255,255,255,.045)" if isDarkTheme() else "rgba(255,255,255,.72)"
            foreground, border = "palette(text)", accent
        else:
            background, foreground, border = "rgba(128,128,128,.08)", "#888888", "#888888"
        chip_width = max(96, min(220, self.fontMetrics().horizontalAdvance(self.text()) + 46))
        self.setFixedWidth(chip_width)
        self.setStyleSheet(f"""
            QPushButton {{
                min-height: 42px; padding: 0 18px; border-radius: 21px;
                border: 1px solid {border}; background: {background}; color: {foreground};
                font-size: 14px; font-weight: {'700' if active else '600'};
            }}
            QPushButton:hover {{ border-width: 2px; background: {accent}; color: white; }}
            QPushButton:pressed {{ padding-top: 2px; }}
        """)

    def mousePressEvent(self, event):
        self._drag_press(event)
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if not self._drag_move(event):
            super().mouseMoveEvent(event)


class PresetGroupCard(CardWidget):
    presetActivated = Signal(str)
    renameRequested = Signal(str)
    presetMoved = Signal(str, str, object)
    groupReordered = Signal(str, object)

    def __init__(self, group_name: str, presets: list[dict], active_id: str | None,
                 color_index: int, parent=None):
        super().__init__(parent)
        self.group_name = str(group_name or "")
        self.chips: list[PresetChip] = []
        self.color_index = color_index
        self.setAcceptDrops(True)
        self.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        metrics = self.fontMetrics()
        estimated_chips = []
        for preset in presets:
            name = str(preset.get("name") or preset.get("id") or "未命名")
            label = ("当前 · " if str(preset.get("id") or "") == str(active_id or "") else "") + name
            if preset.get("enabled") is False:
                label += " · 停用"
            estimated_chips.append(max(96, min(220, metrics.horizontalAdvance(label) + 46)))
        estimated = 28 + sum(estimated_chips) + max(0, len(estimated_chips) - 1) * 8
        self.preferred_width = max(280, min(440, estimated))
        self.setObjectName("presetFolderCard")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 13)
        layout.setSpacing(8)
        head = QHBoxLayout()
        head.setSpacing(7)
        head.addWidget(DragHandle(self.group_name))
        title = QPushButton(self.group_name or "未分组")
        title.setMinimumHeight(44)
        title.setCursor(Qt.PointingHandCursor)
        title.setToolTip("点击重命名此文件夹")
        self.title = title
        title.clicked.connect(lambda: self.renameRequested.emit(self.group_name))
        head.addWidget(title, 1)
        count = BodyLabel(str(len(presets)))
        self.count = count
        head.addWidget(count)
        layout.addLayout(head)

        self.body = QWidget()
        self.body.setStyleSheet("background: transparent;")
        # Hidden here only means the parent window has not been shown yet; every
        # capsule must still participate in the pre-show height calculation.
        self.chip_flow = FlowLayout(self.body, needAni=False, isTight=False)
        self.chip_flow.setContentsMargins(0, 0, 0, 0)
        self.chip_flow.setHorizontalSpacing(8)
        self.chip_flow.setVerticalSpacing(8)
        accent, _soft = self._palette()
        for preset in presets:
            chip = PresetChip(preset, str(preset.get("id") or "") == str(active_id or ""),
                              accent, self.body)
            chip.activated.connect(self.presetActivated)
            self.chips.append(chip)
            self.chip_flow.addWidget(chip)
        layout.addWidget(self.body)
        self.apply_palette()
        self.set_available_width(self.preferred_width)

    def _palette(self):
        colors = group_colors()
        return colors[self.color_index % len(colors)]

    def apply_palette(self):
        accent, soft = self._palette()
        self.accent = accent
        self._base_style = f"""
            CardWidget#presetFolderCard {{
                border: 1px solid {accent}; border-radius: 14px;
                background: {soft};
            }}
        """
        self.setStyleSheet(self._base_style)
        self.title.setStyleSheet(f"""
            QPushButton {{ border: none; background: transparent; color: {accent};
                font-size: 15px; font-weight: 800; text-align: left; padding: 0 4px; }}
            QPushButton:hover {{ text-decoration: underline; }}
        """)
        self.count.setStyleSheet(f"color: {accent}; font-weight: 700;")
        for chip in self.chips:
            chip.update_preset(chip._preset, chip._active, accent)

    def update_presets(self, presets: list[dict], active_id: str | None):
        """Apply labels and state without recreating any folder or capsule."""
        accent, _soft = self._palette()
        for chip, preset in zip(self.chips, presets):
            chip.update_preset(
                preset, str(preset.get("id") or "") == str(active_id or ""), accent)
        self.count.setText(str(len(presets)))
        self.apply_palette()

    def set_available_width(self, available_width):
        """Fit one folder into its grid column and recalculate wrapped-chip height."""
        card_width = max(1, min(self.preferred_width, int(available_width)))
        self.setFixedWidth(card_width)
        # Use the layout's own size hints, not QWidget.width() before polish;
        # the latter is stale on Windows and used to crop the final wrapped chip.
        body_height = self.chip_flow.heightForWidth(max(1, card_width - 28))
        self.body.setFixedHeight(max(44, body_height))
        # 10px top + 44px header + 8px gap + 13px bottom.
        self.setFixedHeight(75 + max(44, body_height))
        self.updateGeometry()

    @staticmethod
    def _decode(event, mime_name: str) -> str:
        return bytes(event.mimeData().data(mime_name)).decode("utf-8", errors="replace")

    def dragEnterEvent(self, event):
        if event.mimeData().hasFormat(PRESET_MIME) or event.mimeData().hasFormat(GROUP_MIME):
            event.acceptProposedAction()
            self.setStyleSheet(self._base_style +
                               "CardWidget#presetFolderCard { border-width: 4px; }")
        else:
            event.ignore()

    def dragLeaveEvent(self, event):
        self.setStyleSheet(self._base_style)
        super().dragLeaveEvent(event)

    def _before_chip(self, position: QPoint) -> str | None:
        for chip in self.chips:
            top_left = chip.mapTo(self, QPoint(0, 0))
            rect = chip.rect().translated(top_left)
            if position.y() < rect.top():
                return chip.preset_id
            if rect.top() <= position.y() <= rect.bottom() and position.x() < rect.center().x():
                return chip.preset_id
        return None

    def dropEvent(self, event):
        self.setStyleSheet(self._base_style)
        if event.mimeData().hasFormat(PRESET_MIME):
            preset_id = self._decode(event, PRESET_MIME)
            self.presetMoved.emit(preset_id, self.group_name,
                                  self._before_chip(event.position().toPoint()))
            event.acceptProposedAction()
            return
        if event.mimeData().hasFormat(GROUP_MIME):
            group = self._decode(event, GROUP_MIME)
            self.groupReordered.emit(group, self.group_name)
            event.acceptProposedAction()
            return
        event.ignore()


class PresetCatalog(QWidget):
    """A responsive folder grid; the owning page persists emitted mutations."""

    presetActivated = Signal(str)
    renameGroupRequested = Signal(str)
    presetMoved = Signal(str, str, object)
    groupReordered = Signal(str, object)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
        self.grid = QGridLayout(self)
        self.grid.setSizeConstraint(QLayout.SetNoConstraint)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setHorizontalSpacing(12)
        self.grid.setVerticalSpacing(12)
        self.grid.setAlignment(Qt.AlignLeft | Qt.AlignTop)
        self.cards: list[PresetGroupCard] = []
        self._columns = 0
        self._layout_width = -1
        self._watched_viewport = None
        self._reflow_pending = False
        self._structure = ()
        qconfig.themeChanged.connect(self._theme_changed)

    @staticmethod
    def _signature(grouped):
        return tuple((str(group or ""), tuple(str(item.get("id") or "") for item in items))
                     for group, items in grouped)

    def _theme_changed(self, *_args):
        for card in self.cards:
            card.apply_palette()
        self._schedule_reflow(force=True)

    def minimumSizeHint(self):
        # A previous three-column arrangement must never become the minimum
        # width of the scroll content; doing so prevents a maximized window from
        # shrinking back and merely clips the third folder off-screen.
        return QSize(0, max(0, self.height()))

    def sizeHint(self):
        return QSize(0, max(0, self.height()))

    def _find_viewport(self):
        parent = self.parentWidget()
        while parent is not None:
            if isinstance(parent, QAbstractScrollArea):
                return parent.viewport()
            parent = parent.parentWidget()
        return None

    def _ensure_viewport_watch(self):
        viewport = self._find_viewport()
        if viewport is self._watched_viewport:
            return
        if self._watched_viewport is not None:
            self._watched_viewport.removeEventFilter(self)
        self._watched_viewport = viewport
        if viewport is not None:
            viewport.installEventFilter(self)

    def _available_width(self):
        """Return the actually visible width, not stale scroll-content width."""
        width = max(1, self.width())
        self._ensure_viewport_watch()
        viewport = self._watched_viewport
        if viewport is not None:
            left = max(0, self.mapTo(viewport, QPoint(0, 0)).x())
            visible = max(1, viewport.width() - left - 12)
            width = min(width, visible)
        return width

    def _column_count(self, width=None):
        # 280px remains comfortably readable; narrower windows step down instead
        # of keeping a folder outside the visible viewport.
        width = self._available_width() if width is None else max(0, int(width))
        if width >= 864:
            return 3
        if width >= 572:
            return 2
        return 1

    def _reflow(self, force=False):
        layout_width = self._available_width()
        columns = self._column_count(layout_width)
        if columns == self._columns and layout_width == self._layout_width and not force:
            return
        while self.grid.count():
            self.grid.takeAt(0)
        column_width = max(1, (layout_width - (columns - 1) * 12) // columns)
        row_heights = []
        for index, card in enumerate(self.cards):
            card.set_available_width(column_width)
            row = index // columns
            self.grid.addWidget(card, row, index % columns,
                                Qt.AlignLeft | Qt.AlignTop)
            if row == len(row_heights):
                row_heights.append(card.height())
            else:
                row_heights[row] = max(row_heights[row], card.height())
        # Do not stretch cells across a stale, wider scroll-content geometry.
        # Cards are sized from the visible viewport and packed from the left.
        for column in range(3):
            self.grid.setColumnStretch(column, 0)
        self._columns = columns
        self._layout_width = layout_width
        self.grid.invalidate()
        self.setFixedHeight(sum(row_heights) + max(0, len(row_heights) - 1) * 12)
        self.updateGeometry()

    def _schedule_reflow(self, force=False):
        if force:
            self._layout_width = -1
        if self._reflow_pending:
            return
        self._reflow_pending = True
        QTimer.singleShot(0, self._run_scheduled_reflow)

    def _run_scheduled_reflow(self):
        self._reflow_pending = False
        self._reflow()

    def set_presets(self, presets: list[dict], active_id: str | None):
        grouped = grouped_presets(presets)
        signature = self._signature(grouped)
        if signature == self._structure and len(grouped) == len(self.cards):
            for card, (_group, items) in zip(self.cards, grouped):
                card.update_presets(items, active_id)
            self._reflow(force=True)
            return
        for card in self.cards:
            self.grid.removeWidget(card)
            card.deleteLater()
        self.cards = []
        for index, (group, items) in enumerate(grouped):
            card = PresetGroupCard(group, items, active_id, index, self)
            card.presetActivated.connect(self.presetActivated)
            card.renameRequested.connect(self.renameGroupRequested)
            card.presetMoved.connect(self.presetMoved)
            card.groupReordered.connect(self.groupReordered)
            self.cards.append(card)
        self._structure = signature
        self._reflow(force=True)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        # Coalesce the resize storm into one layout pass per event-loop turn.
        # There is no animation; the new arrangement is visible on the next
        # paint, while expensive FlowLayout height calculations are not repeated
        # dozens of times for a single mouse movement.
        self._schedule_reflow()

    def showEvent(self, event):
        super().showEvent(event)
        self._ensure_viewport_watch()
        self._schedule_reflow(force=True)

    def eventFilter(self, watched, event):
        if watched is self._watched_viewport and event.type() in (
                QEvent.Type.Resize, QEvent.Type.Show):
            self._schedule_reflow(force=True)
        return super().eventFilter(watched, event)

    def dragEnterEvent(self, event):
        if event.mimeData().hasFormat(GROUP_MIME):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event):
        if not event.mimeData().hasFormat(GROUP_MIME):
            event.ignore()
            return
        group = bytes(event.mimeData().data(GROUP_MIME)).decode("utf-8", errors="replace")
        self.groupReordered.emit(group, None)
        event.acceptProposedAction()
