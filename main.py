import sys
from datetime import datetime
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
                             QGroupBox, QLabel, QLineEdit, QPushButton, QTableWidget,
                             QTableWidgetItem, QSpinBox, QFormLayout, QMessageBox, QTab,
                             QTabWidget, QComboBox, QHeaderView)
from PyQt5.QtCore import Qt, QDateTime
from PyQt5.QtGui import QFont, QColor, QBrush

from planner_logic import CastingPlanner, CastingType

class CastingPlannerApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.planner = CastingPlanner()
        self.init_ui()
        self.resize(1400, 800)
        self.show()
    
    def init_ui(self):
        """Ana arayüzü başlat"""
        self.setWindowTitle("DÖKÜM PLANLAMA SİSTEMİ")
        
        # Ana widget
        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        main_layout = QHBoxLayout()
        
        # Sol panel: Stok giriş
        left_panel = self.create_stock_panel()
        
        # Sağ panel: Plan tablosu
        right_panel = self.create_plan_panel()
        
        main_layout.addWidget(left_panel, 1)
        main_layout.addWidget(right_panel, 2)
        
        main_widget.setLayout(main_layout)
    
    def create_stock_panel(self):
        """Stok giriş paneli"""
        group = QGroupBox("STOK BİLGİSİ")
        group.setStyleSheet("QGroupBox { font-weight: bold; font-size: 12px; }")
        layout = QFormLayout()
        
        self.stock_inputs = {}
        
        for diameter in ["127", "178", "203", "254"]:
            spinbox = QSpinBox()
            spinbox.setMaximum(10000)
            spinbox.setValue(100)
            spinbox.setSuffix(" ton")
            self.stock_inputs[diameter] = spinbox
            layout.addRow(f"{diameter}mm Çap Stok:", spinbox)
        
        layout.addRow("", QLabel(""))  # Boş satır
        
        # Kullanılan miktarlar (salt okunur)
        usage_group = QGroupBox("Günlük Kullanım")
        usage_layout = QFormLayout()
        usage_layout.addRow("127mm:", QLabel("13 ton/gün"))
        usage_layout.addRow("178mm:", QLabel("20 ton/gün"))
        usage_layout.addRow("203mm:", QLabel("24 ton/gün"))
        usage_layout.addRow("254mm:", QLabel("36 ton/gün"))
        layout.addRow(usage_group)
        
        layout.addRow("", QLabel(""))  # Boş satır
        
        # Hazırlık süreleri
        prep_group = QGroupBox("Hazırlık Süresi")
        prep_layout = QFormLayout()
        prep_layout.addRow("127mm:", QLabel("20 saat"))
        prep_layout.addRow("Diğerleri:", QLabel("24 saat"))
        layout.addRow(prep_group)
        
        layout.addRow("", QLabel(""))  # Boş satır
        
        # Planı oluştur butonu
        self.generate_btn = QPushButton("📋 PLANI OLUŞTUR")
        self.generate_btn.setStyleSheet(
            "QPushButton { background-color: #4CAF50; color: white; font-weight: bold; "
            "padding: 10px; border-radius: 5px; }"
        )
        self.generate_btn.clicked.connect(self.generate_plan)
        layout.addRow(self.generate_btn)
        
        group.setLayout(layout)
        return group
    
    def create_plan_panel(self):
        """Haftalık plan paneli"""
        group = QGroupBox("HAFTALIK PLAN")
        group.setStyleSheet("QGroupBox { font-weight: bold; font-size: 12px; }")
        layout = QVBoxLayout()
        
        # Tablo
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels([
            "Slot", "Gün/Saat", "Çap", "Tür", "Durum", "Müşteri Adı", "Notu"
        ])
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setSelectionBehavior(self.table.SelectRows)
        layout.addWidget(self.table)
        
        # Müşteri döküm ekleme
        customer_layout = QHBoxLayout()
        customer_layout.addWidget(QLabel("Müşteri Döküm Ekle:"))
        
        self.slot_combo = QComboBox()
        customer_layout.addWidget(QLabel("Slot:"))
        customer_layout.addWidget(self.slot_combo)
        
        self.diameter_combo = QComboBox()
        self.diameter_combo.addItems(["127", "178", "203", "254"])
        customer_layout.addWidget(QLabel("Çap:"))
        customer_layout.addWidget(self.diameter_combo)
        
        self.customer_input = QLineEdit()
        self.customer_input.setPlaceholderText("Müşteri Adı...")
        customer_layout.addWidget(self.customer_input)
        
        add_customer_btn = QPushButton("✚ Ekle")
        add_customer_btn.clicked.connect(self.add_customer_casting)
        customer_layout.addWidget(add_customer_btn)
        
        layout.addLayout(customer_layout)
        
        group.setLayout(layout)
        return group
    
    def generate_plan(self):
        """Planı oluştur"""
        # Stokları al
        stocks = {
            "127": self.stock_inputs["127"].value(),
            "178": self.stock_inputs["178"].value(),
            "203": self.stock_inputs["203"].value(),
            "254": self.stock_inputs["254"].value(),
        }
        
        self.planner.set_stocks(stocks)
        castings = self.planner.generate_weekly_plan()
        
        # Kritik zamanları göster
        criticals = self.planner.calculate_critical_times()
        if criticals:
            msg = "KRİTİK DÖKÜM ZAMANLARı:\n\n"
            for c in criticals:
                msg += (f"{c['diameter']}mm: {c['time'].strftime('%a %H:%M')} "
                       f"({c['hours_until_critical']:.1f} saat sonra)\n"
                       f"  Stok: {c['stock']:.1f}ton, Kullanım: {c['daily_usage']}ton/gün\n\n")
            QMessageBox.information(self, "Kritik Zamanlar", msg)
        
        # Tabloyu doldur
        self.update_table()
        
        # Slot combo'sunu doldur
        self.slot_combo.clear()
        for casting in castings:
            if casting.casting_type == CastingType.CUSTOMER:
                self.slot_combo.addItem(f"Slot {casting.slot_number}", casting.slot_number)
    
    def update_table(self):
        """Tabloyu güncelle"""
        castings = self.planner.castings
        self.table.setRowCount(len(castings))
        
        for row, casting in enumerate(castings):
            day_time = casting.scheduled_time.strftime("%a %d/%m %H:%M")
            
            # Renklendirme
            if casting.casting_type == CastingType.OWN:
                bg_color = QColor(255, 200, 124)  # Turuncu
            else:
                bg_color = QColor(200, 230, 201)  # Yeşil
            
            items = [
                str(casting.slot_number),
                day_time,
                casting.diameter,
                casting.casting_type.value,
                casting.status,
                casting.customer_name or "",
                ""
            ]
            
            for col, item_text in enumerate(items):
                item = QTableWidgetItem(item_text)
                item.setBackground(QBrush(bg_color))
                self.table.setItem(row, col, item)
        
        # Sütun genişliklerini ayarla
        self.table.resizeColumnsToContents()
    
    def add_customer_casting(self):
        """Müşteri dökümü ekle"""
        slot_number = self.slot_combo.currentData()
        diameter = self.diameter_combo.currentText()
        customer_name = self.customer_input.text().strip()
        
        if not customer_name:
            QMessageBox.warning(self, "Hata", "Müşteri adı girin!")
            return
        
        if slot_number is None:
            QMessageBox.warning(self, "Hata", "Lütfen önce planı oluşturun!")
            return
        
        if self.planner.add_customer_casting(slot_number, diameter, customer_name):
            self.customer_input.clear()
            self.update_table()
            QMessageBox.information(self, "Başarılı", f"Müşteri dökümü eklendi!")
        else:
            QMessageBox.warning(self, "Hata", "Slot bulunamadı!")

def main():
    app = QApplication(sys.argv)
    window = CastingPlannerApp()
    sys.exit(app.exec_())

if __name__ == "__main__":
    main()
