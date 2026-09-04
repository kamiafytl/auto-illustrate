"""Reusable visual pieces for the compact preset editor."""
from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (QButtonGroup, QHBoxLayout, QLabel, QPushButton,
                               QSizePolicy, QVBoxLayout, QWidget)
from qfluentwidgets import BodyLabel, CardWidget, SubtitleLabel


ROLE_COLORS = {
    "main": ("#778494", "rgba(119,132,148,.09)"),
    "f1": ("#ad7891", "rgba(173,120,145,.09)"),
    "f2": ("#8c81aa", "rgba(140,129,170,.09)"),
    "other": ("#a88c61", "rgba(168,140,97,.09)"),
}
ROLE_LABELS = (("main", "主要"), ("f1", "女1"), ("f2", "女2"), ("other", "其他"))


def role_color(role: str) -> tuple[str, str]:
    return ROLE_COLORS.get(role, ROLE_COLORS["main"])


def tint_card(widget: QWidget, role: str, object_name: str = "roleTintCard"):
    accent, soft = role_color(role)
    widget.setObjectName(object_name)
    widget.setStyleSheet(f"""
        #{object_name} {{
            border: 1px solid rgba(128,128,128,.28);
            border-left: 5px solid {accent}; border-radius: 11px;
            background: {soft};
        }}
    """)


class RoleSelector(QWidget):
    roleChanged = Signal(str)

    def __init__(self, role="main", parent=None):
        super().__init__(parent)
        self._role = role if role in ROLE_COLORS else "main"
        self.buttons: dict[str, QPushButton] = {}
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        group = QButtonGroup(self)
        group.setExclusive(True)
        for key, label in ROLE_LABELS:
            button = QPushButton(label)
            button.setCheckable(True)
            button.setChecked(key == self._role)
            button.setMinimumHeight(44)
            button.setMinimumWidth(50)
            accent, _soft = role_color(key)
            button.setStyleSheet(f"""
                QPushButton {{ border: 1px solid rgba(128,128,128,.45); border-radius: 18px;
                    padding: 0 10px; background: rgba(128,128,128,.08); font-weight: 600; }}
                QPushButton:hover {{ border: 2px solid {accent}; }}
                QPushButton:checked {{ background: {accent}; color: white; border: 2px solid {accent}; }}
            """)
            button.clicked.connect(lambda _checked=False, r=key: self.set_role(r, emit=True))
            group.addButton(button)
            self.buttons[key] = button
            layout.addWidget(button)

    def role(self) -> str:
        return self._role

    def set_role(self, role: str, *, emit=False):
        role = role if role in ROLE_COLORS else "main"
        changed = role != self._role
        self._role = role
        if role in self.buttons:
            self.buttons[role].setChecked(True)
        if changed and emit:
            self.roleChanged.emit(role)


class SectionCard(CardWidget):
    """Old-webapp-like numbered section with a strong visual header."""

    def __init__(self, number: str, title: str, hint: str = "", parent=None):
        super().__init__(parent)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Minimum)
        self.setObjectName("presetSectionCard")
        self.setStyleSheet("""
            CardWidget#presetSectionCard {
                border: 1px solid rgba(128,128,128,.28); border-top: 4px solid #8585ad;
                border-radius: 14px; background: rgba(128,128,128,.055);
            }
        """)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(16, 14, 16, 16)
        outer.setSpacing(10)
        head = QHBoxLayout()
        badge = QLabel(number)
        badge.setFixedSize(30, 30)
        badge.setStyleSheet("""
            QLabel { color: white; font-weight: 800; border-radius: 9px;
                background: #8585ad; qproperty-alignment: AlignCenter; }
        """)
        head.addWidget(badge)
        head.addWidget(SubtitleLabel(title))
        if hint:
            hint_label = BodyLabel(hint)
            hint_label.setWordWrap(True)
            hint_label.setStyleSheet("color: rgba(128,128,128,.95); font-size: 12px;")
            head.addWidget(hint_label, 1)
        else:
            head.addStretch(1)
        outer.addLayout(head)
        line = QWidget()
        line.setFixedHeight(1)
        line.setStyleSheet("background: rgba(128,128,128,.25);")
        outer.addWidget(line)
        self.body_widget = QWidget()
        self.body_widget.setStyleSheet("background: transparent;")
        self.body = QVBoxLayout(self.body_widget)
        self.body.setContentsMargins(0, 0, 0, 0)
        self.body.setSpacing(10)
        outer.addWidget(self.body_widget)


def large_button(button: QPushButton, *, minimum_width: int = 0):
    button.setMinimumHeight(44)
    if minimum_width:
        button.setMinimumWidth(minimum_width)
    button.setStyleSheet(button.styleSheet() + "font-size: 14px; font-weight: 600; padding: 0 14px;")
    return button
