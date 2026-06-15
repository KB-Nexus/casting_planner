using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace CastingPlanner
{
    public partial class MainForm : Form
    {
        private CastingPlanner planner;
        private Dictionary<string, NumericUpDown> stockInputs;

        public MainForm()
        {
            InitializeComponent();
            planner = new CastingPlanner();
            stockInputs = new Dictionary<string, NumericUpDown>();
            SetupUI();
        }

        private void SetupUI()
        {
            this.Text = "DÖKÜM PLANLAMA SİSTEMİ";
            this.Size = new Size(1400, 800);
            this.StartPosition = FormStartPosition.CenterScreen;

            TableLayoutPanel mainLayout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                Padding = new Padding(10)
            };
            mainLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
            mainLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 70));

            // Sol panel - Stok giriş
            Panel leftPanel = CreateStockPanel();
            mainLayout.Controls.Add(leftPanel, 0, 0);

            // Sağ panel - Plan tablosu
            Panel rightPanel = CreatePlanPanel();
            mainLayout.Controls.Add(rightPanel, 1, 0);

            this.Controls.Add(mainLayout);
        }

        private Panel CreateStockPanel()
        {
            Panel panel = new Panel { Dock = DockStyle.Fill };
            
            GroupBox groupBox = new GroupBox
            {
                Text = "STOK BİLGİSİ",
                Dock = DockStyle.Fill,
                Padding = new Padding(10),
                Font = new Font("Arial", 10, FontStyle.Bold)
            };

            TableLayoutPanel layout = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                ColumnCount = 2,
                RowCount = 10,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));

            int row = 0;
            foreach (string diameter in new[] { "127", "178", "203", "254" })
            {
                Label label = new Label
                {
                    Text = $"{diameter}mm Çap Stok:",
                    AutoSize = true,
                    Font = new Font("Arial", 9)
                };
                NumericUpDown spinBox = new NumericUpDown
                {
                    Maximum = 10000,
                    Value = 100,
                    Width = 100
                };
                stockInputs[diameter] = spinBox;

                layout.Controls.Add(label, 0, row);
                layout.Controls.Add(spinBox, 1, row);
                row++;
            }

            // Kullanılan miktarlar
            row++;
            Label usageLabel = new Label
            {
                Text = "Günlük Kullanım:",
                Font = new Font("Arial", 9, FontStyle.Bold),
                AutoSize = true
            };
            layout.Controls.Add(usageLabel, 0, row);

            row++;
            layout.Controls.Add(new Label { Text = "127mm: 13 ton", AutoSize = true, Font = new Font("Arial", 8) }, 0, row);
            layout.Controls.Add(new Label { Text = "178mm: 20 ton", AutoSize = true, Font = new Font("Arial", 8) }, 1, row);
            
            row++;
            layout.Controls.Add(new Label { Text = "203mm: 24 ton", AutoSize = true, Font = new Font("Arial", 8) }, 0, row);
            layout.Controls.Add(new Label { Text = "254mm: 36 ton", AutoSize = true, Font = new Font("Arial", 8) }, 1, row);

            // Hazırlık süreleri
            row++;
            Label prepLabel = new Label
            {
                Text = "Hazırlık Süresi:",
                Font = new Font("Arial", 9, FontStyle.Bold),
                AutoSize = true
            };
            layout.Controls.Add(prepLabel, 0, row);

            row++;
            layout.Controls.Add(new Label { Text = "127mm: 20 saat", AutoSize = true, Font = new Font("Arial", 8) }, 0, row);
            layout.Controls.Add(new Label { Text = "Diğerleri: 24 saat", AutoSize = true, Font = new Font("Arial", 8) }, 1, row);

            // Buton
            row++;
            Button generateBtn = new Button
            {
                Text = "📋 PLANI OLUŞTUR",
                Dock = DockStyle.Top,
                Height = 40,
                Font = new Font("Arial", 10, FontStyle.Bold),
                BackColor = Color.FromArgb(76, 175, 80),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            generateBtn.Click += (s, e) => GeneratePlan();
            layout.Controls.Add(generateBtn, 0, row);
            layout.SetColumnSpan(generateBtn, 2);

            groupBox.Controls.Add(layout);
            panel.Controls.Add(groupBox);
            
            return panel;
        }

        private Panel CreatePlanPanel()
        {
            Panel panel = new Panel { Dock = DockStyle.Fill };

            GroupBox groupBox = new GroupBox
            {
                Text = "HAFTALIK PLAN",
                Dock = DockStyle.Fill,
                Padding = new Padding(10),
                Font = new Font("Arial", 10, FontStyle.Bold)
            };

            TableLayoutPanel layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2,
                AutoSize = false
            };
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 85));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 15));

            // Tablo
            DataGridView table = new DataGridView
            {
                Dock = DockStyle.Fill,
                AutoGenerateColumns = false,
                AllowUserToAddRows = false,
                ReadOnly = true,
                RowHeadersVisible = false,
                AlternatingRowsDefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.WhiteSmoke }
            };

            table.Columns.Add(new DataGridViewTextBoxColumn { Name = "Slot", Width = 60 });
            table.Columns.Add(new DataGridViewTextBoxColumn { Name = "Gün/Saat", Width = 120 });
            table.Columns.Add(new DataGridViewTextBoxColumn { Name = "Çap", Width = 80 });
            table.Columns.Add(new DataGridViewTextBoxColumn { Name = "Tür", Width = 120 });
            table.Columns.Add(new DataGridViewTextBoxColumn { Name = "Durum", Width = 200, AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill });
            table.Columns.Add(new DataGridViewTextBoxColumn { Name = "Müşteri", Width = 150 });

            Tag = table;  // Tablo referansını sakla

            layout.Controls.Add(table, 0, 0);

            // Müşteri döküm ekleme
            Panel customerPanel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(5) };
            FlowLayoutPanel flowLayout = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                AutoSize = false,
                WrapContents = false
            };

            flowLayout.Controls.Add(new Label { Text = "Müşteri Döküm Ekle:", AutoSize = true, Font = new Font("Arial", 9, FontStyle.Bold) });
            
            ComboBox slotCombo = new ComboBox { Width = 80 };
            Tag = slotCombo;
            flowLayout.Controls.Add(new Label { Text = "Slot:", AutoSize = true });
            flowLayout.Controls.Add(slotCombo);

            ComboBox diameterCombo = new ComboBox { Width = 80 };
            diameterCombo.Items.AddRange(new[] { "127", "178", "203", "254" });
            diameterCombo.SelectedIndex = 0;
            flowLayout.Controls.Add(new Label { Text = "Çap:", AutoSize = true });
            flowLayout.Controls.Add(diameterCombo);

            TextBox customerInput = new TextBox { Width = 150, PlaceholderText = "Müşteri Adı..." };
            flowLayout.Controls.Add(customerInput);

            Button addBtn = new Button { Text = "✚ Ekle", Width = 80, Height = 25 };
            addBtn.Click += (s, e) => AddCustomerCasting(slotCombo, diameterCombo, customerInput, table);
            flowLayout.Controls.Add(addBtn);

            customerPanel.Controls.Add(flowLayout);
            layout.Controls.Add(customerPanel, 0, 1);

            groupBox.Controls.Add(layout);
            panel.Controls.Add(groupBox);

            return panel;
        }

        private void GeneratePlan()
        {
            try
            {
                // Stokları al
                var stocks = new Dictionary<string, int>
                {
                    { "127", (int)stockInputs["127"].Value },
                    { "178", (int)stockInputs["178"].Value },
                    { "203", (int)stockInputs["203"].Value },
                    { "254", (int)stockInputs["254"].Value }
                };

                planner.SetStocks(stocks);
                planner.GenerateWeeklyPlan();

                // Kritik zamanları göster
                var criticals = planner.CalculateCriticalTimes();
                if (criticals.Count > 0)
                {
                    string msg = "KRİTİK DÖKÜM ZAMANLARı:\n\n";
                    foreach (var c in criticals)
                    {
                        msg += $"{c.Diameter}mm: {c.CriticalTime:ddd HH:mm} ({c.HoursUntilCritical:F1} saat sonra)\n";
                        msg += $"  Stok: {c.Stock} ton, Kullanım: {c.DailyUsage} ton/gün\n\n";
                    }
                    MessageBox.Show(msg, "Kritik Zamanlar", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }

                UpdateTable();
                UpdateSlotCombo();
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Hata: {ex.Message}", "Hata", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void UpdateTable()
        {
            var table = Tag as DataGridView;
            if (table == null) table = FindDataGridView();

            table.Rows.Clear();

            foreach (var casting in planner.Castings)
            {
                string dayTime = casting.ScheduledTime.ToString("ddd dd/MM HH:mm");
                
                Color bgColor = casting.CastingType == CastingTypeEnum.OwnCasting
                    ? Color.FromArgb(255, 200, 124)  // Turuncu
                    : Color.FromArgb(200, 230, 201); // Yeşil

                int rowIndex = table.Rows.Add();
                table.Rows[rowIndex].Cells["Slot"].Value = casting.SlotNumber;
                table.Rows[rowIndex].Cells["Gün/Saat"].Value = dayTime;
                table.Rows[rowIndex].Cells["Çap"].Value = casting.Diameter;
                table.Rows[rowIndex].Cells["Tür"].Value = casting.CastingType == CastingTypeEnum.OwnCasting ? "Kendi Döküm" : "Müşteri Döküm";
                table.Rows[rowIndex].Cells["Durum"].Value = casting.Status;
                table.Rows[rowIndex].Cells["Müşteri"].Value = casting.CustomerName ?? "";

                foreach (DataGridViewCell cell in table.Rows[rowIndex].Cells)
                {
                    cell.Style.BackColor = bgColor;
                }
            }
        }

        private void UpdateSlotCombo()
        {
            var slotCombo = FindComboBox("slotCombo");
            if (slotCombo == null) return;

            slotCombo.Items.Clear();
            foreach (var casting in planner.Castings.Where(c => c.CastingType == CastingTypeEnum.CustomerCasting))
            {
                slotCombo.Items.Add($"Slot {casting.SlotNumber}");
            }
        }

        private void AddCustomerCasting(ComboBox slotCombo, ComboBox diameterCombo, TextBox customerInput, DataGridView table)
        {
            try
            {
                if (slotCombo.SelectedIndex < 0)
                {
                    MessageBox.Show("Lütfen slot seçin!", "Hata", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                string slotText = slotCombo.SelectedItem.ToString();
                int slotNumber = int.Parse(slotText.Split(' ')[1]);
                string diameter = diameterCombo.SelectedItem.ToString();
                string customerName = customerInput.Text.Trim();

                if (string.IsNullOrEmpty(customerName))
                {
                    MessageBox.Show("Müşteri adı girin!", "Hata", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                if (planner.AddCustomerCasting(slotNumber, diameter, customerName))
                {
                    customerInput.Clear();
                    UpdateTable();
                    MessageBox.Show("Müşteri dökümü eklendi!", "Başarılı", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    MessageBox.Show("Slot bulunamadı!", "Hata", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Hata: {ex.Message}", "Hata", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private DataGridView FindDataGridView()
        {
            foreach (Control control in this.Controls)
            {
                DataGridView dgv = FindDataGridViewRecursive(control);
                if (dgv != null) return dgv;
            }
            return null;
        }

        private DataGridView FindDataGridViewRecursive(Control control)
        {
            if (control is DataGridView dgv) return dgv;
            foreach (Control child in control.Controls)
            {
                DataGridView result = FindDataGridViewRecursive(child);
                if (result != null) return result;
            }
            return null;
        }

        private ComboBox FindComboBox(string hint)
        {
            foreach (Control control in this.Controls)
            {
                ComboBox cb = FindComboBoxRecursive(control);
                if (cb != null) return cb;
            }
            return null;
        }

        private ComboBox FindComboBoxRecursive(Control control)
        {
            if (control is ComboBox cb && cb.Width == 80) return cb;
            foreach (Control child in control.Controls)
            {
                ComboBox result = FindComboBoxRecursive(child);
                if (result != null) return result;
            }
            return null;
        }

        private void InitializeComponent()
        {
            this.SuspendLayout();
            this.ResumeLayout(false);
        }
    }

    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.Run(new MainForm());
        }
    }
}
