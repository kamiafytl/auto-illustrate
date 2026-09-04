from __future__ import annotations

from PySide6.QtWidgets import QFileDialog, QVBoxLayout, QWidget
from qfluentwidgets import (BodyLabel, ComboBoxSettingCard, FluentIcon,
                            OptionsConfigItem, OptionsValidator, PushSettingCard,
                            SettingCardGroup, SwitchSettingCard, TitleLabel)

from nai_terminal.gui.autosave import AutoSaveController
from nai_terminal.gui_store import win_to_wsl_path


class OptionsPage(QWidget):
    def __init__(self, config_store, terminal_store, executor, theme_callback=None, parent=None):
        super().__init__(parent)
        self.setObjectName("optionsPage")
        self.config_store = config_store
        self.terminal_store = terminal_store
        self.theme_callback = theme_callback or (lambda _theme: None)

        # Setting cards require config-item metadata; persistence remains owned by
        # TerminalConfig so this GUI never creates a second settings file.
        self._theme_item = OptionsConfigItem(
            "Terminal", "UiTheme", "auto",
            OptionsValidator(["auto", "light", "dark"]))

        self.clean = SwitchSettingCard(
            FluentIcon.BROOM, "Clean 模式",
            "开启：公开位置输出 clean 图，带 meta 原版另存到下方归档路径；关闭：公开位置直接输出原图")
        self.theme = ComboBoxSettingCard(
            self._theme_item, FluentIcon.BRUSH, "界面主题",
            "切换后立即生效", ["跟随系统", "浅色", "深色"])
        self.global_enabled = SwitchSettingCard(
            FluentIcon.GLOBE, "启用全局层", "应用全局删除与替换规则")
        self.archive = PushSettingCard(
            "选择文件夹", FluentIcon.FOLDER, "原版归档路径",
            "未设置；Windows 路径保存时会转换为 WSL 路径")
        self.archive.clicked.connect(self.choose_archive)
        self.theme.comboBox.currentIndexChanged.connect(self.theme_changed)

        group = SettingCardGroup("本机与全局设置", self)
        group.addSettingCards([self.clean, self.theme, self.global_enabled, self.archive])
        self.message = BodyLabel("")
        self.message.setWordWrap(True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 28, 32, 28)
        layout.addWidget(TitleLabel("选项"))
        layout.addSpacing(10)
        layout.addWidget(group)
        layout.addWidget(self.message)
        layout.addStretch(1)
        self.load()
        self.autosave = AutoSaveController(
            executor, self.snapshot, self.write_snapshot, self.message, 1000, self)
        self.autosave.seed(self.snapshot())
        self.clean.checkedChanged.connect(self.clean_changed)
        self.theme.comboBox.currentIndexChanged.connect(self.autosave.changed)
        self.global_enabled.checkedChanged.connect(self.autosave.changed)

    def load(self):
        cfg = self.config_store.load()
        terminal = self.terminal_store.load()
        self.clean.setChecked(bool(terminal.get("clean_override", False)))
        self.theme.setValue(terminal.get("ui_theme") or "auto")
        self.global_enabled.setChecked(bool((cfg.get("global_layer") or {}).get("enabled")))
        self.archive_path = terminal.get("meta_archive_dir") or ""
        self.archive.setContent(self.archive_path or "未设置；Windows 路径保存时会转换为 WSL 路径")

    def choose_archive(self):
        selected = QFileDialog.getExistingDirectory(self, "选择原版归档文件夹")
        if selected:
            self.archive_path = win_to_wsl_path(selected)
            self.archive.setContent(self.archive_path)
            self.autosave.changed()

    def theme_changed(self, index):
        theme = ("auto", "light", "dark")[max(0, min(index, 2))]
        self.theme_callback(theme)

    def clean_changed(self, *_args):
        # This switch is the execution policy, not a cosmetic preference: queue
        # its write immediately instead of leaving a one-second ambiguity window.
        self.autosave.changed()
        self.autosave.save_now()

    def snapshot(self):
        theme = ("auto", "light", "dark")[self.theme.comboBox.currentIndex()]
        return {"meta_archive_dir": self.archive_path,
                "clean_enabled": self.clean.isChecked(),
                "ui_theme": theme, "global_enabled": self.global_enabled.isChecked()}

    def write_snapshot(self, value):
        self.terminal_store.save(meta_archive_dir=value["meta_archive_dir"],
                                 clean_override=value["clean_enabled"],
                                 ui_theme=value["ui_theme"])
        cfg = self.config_store.load()
        layer = cfg.get("global_layer")
        if not isinstance(layer, dict):
            layer = {"rules": []}
            cfg["global_layer"] = layer
        layer["enabled"] = value["global_enabled"]
        self.config_store.save(cfg)
