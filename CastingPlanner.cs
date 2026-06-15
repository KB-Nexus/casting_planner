using System;
using System.Collections.Generic;
using System.Linq;

namespace CastingPlanner
{
    public enum CastingTypeEnum
    {
        OwnCasting,
        CustomerCasting
    }

    public class DiameterInfo
    {
        public string Diameter { get; set; }
        public int DailyUsage { get; set; }  // ton/gün
        public int PrepHours { get; set; }   // hazırlık saati

        public DiameterInfo(string diameter, int dailyUsage, int prepHours)
        {
            Diameter = diameter;
            DailyUsage = dailyUsage;
            PrepHours = prepHours;
        }
    }

    public class CastingEvent
    {
        public int SlotNumber { get; set; }
        public DateTime ScheduledTime { get; set; }
        public string Diameter { get; set; }
        public CastingTypeEnum CastingType { get; set; }
        public string Status { get; set; }
        public string CustomerName { get; set; }

        public CastingEvent(int slotNumber, DateTime scheduledTime, string diameter, 
                           CastingTypeEnum castingType, string status = "Planlandı")
        {
            SlotNumber = slotNumber;
            ScheduledTime = scheduledTime;
            Diameter = diameter;
            CastingType = castingType;
            Status = status;
            CustomerName = null;
        }
    }

    public class CriticalTime
    {
        public string Diameter { get; set; }
        public DateTime CriticalTime { get; set; }
        public double HoursUntilCritical { get; set; }
        public int Stock { get; set; }
        public int DailyUsage { get; set; }
    }

    public class CastingPlanner
    {
        private const int CASTING_INTERVAL = 11;  // saat
        private const int WEEK_HOURS = 168;

        private Dictionary<string, DiameterInfo> diameters;
        private Dictionary<string, int> stocks;

        public List<CastingEvent> Castings { get; private set; }

        public CastingPlanner()
        {
            diameters = new Dictionary<string, DiameterInfo>
            {
                { "127", new DiameterInfo("127", 13, 20) },
                { "178", new DiameterInfo("178", 20, 24) },
                { "203", new DiameterInfo("203", 24, 24) },
                { "254", new DiameterInfo("254", 36, 24) }
            };

            stocks = new Dictionary<string, int>
            {
                { "127", 100 },
                { "178", 100 },
                { "203", 100 },
                { "254", 100 }
            };

            Castings = new List<CastingEvent>();
        }

        public void SetStocks(Dictionary<string, int> newStocks)
        {
            foreach (var key in newStocks.Keys)
            {
                if (stocks.ContainsKey(key))
                    stocks[key] = newStocks[key];
            }
        }

        public List<CriticalTime> CalculateCriticalTimes()
        {
            DateTime now = DateTime.Now;
            List<CriticalTime> criticals = new List<CriticalTime>();

            foreach (var diamKey in diameters.Keys)
            {
                var diamInfo = diameters[diamKey];
                int stock = stocks[diamKey];
                int dailyUsage = diamInfo.DailyUsage;
                int prepHours = diamInfo.PrepHours;

                // Malzeme kaç gün yetecek?
                double daysUntilEmpty = dailyUsage > 0 ? (double)stock / dailyUsage : double.MaxValue;

                // Boş olmadan kaç saat kaldı?
                double hoursUntilEmpty = daysUntilEmpty * 24;

                // Döküm zamanı: bitiminden prepHours saat öncesi
                double castingTimeHours = hoursUntilEmpty - prepHours;

                if (castingTimeHours > 0 && castingTimeHours < WEEK_HOURS)
                {
                    DateTime criticalTime = now.AddHours(castingTimeHours);
                    criticals.Add(new CriticalTime
                    {
                        Diameter = diamKey,
                        CriticalTime = criticalTime,
                        HoursUntilCritical = castingTimeHours,
                        Stock = stock,
                        DailyUsage = dailyUsage
                    });
                }
            }

            // Kritik zamanları saate göre sırala
            criticals = criticals.OrderBy(c => c.HoursUntilCritical).ToList();

            return criticals;
        }

        public List<CastingEvent> GenerateWeeklyPlan()
        {
            DateTime now = DateTime.Now;
            DateTime startTime = now.Date.AddHours(now.Hour);  // Şu anki saati başlangıç yap

            Castings.Clear();
            int slotNumber = 0;
            DateTime currentTime = startTime;
            DateTime weekEnd = startTime.AddHours(WEEK_HOURS);

            List<CriticalTime> criticalTimes = CalculateCriticalTimes();
            Dictionary<string, CriticalTime> criticalDict = new Dictionary<string, CriticalTime>();

            foreach (var crit in criticalTimes)
            {
                if (!criticalDict.ContainsKey(crit.Diameter))
                    criticalDict[crit.Diameter] = crit;
            }

            // Her 11 saatte bir slot
            while (currentTime < weekEnd)
            {
                slotNumber++;
                bool assigned = false;

                // Hangi çap için kritik slot?
                foreach (var diamKey in new[] { "127", "178", "203", "254" })
                {
                    if (criticalDict.ContainsKey(diamKey))
                    {
                        var crit = criticalDict[diamKey];
                        double timeDiffHours = (currentTime - crit.CriticalTime).TotalHours;

                        if (timeDiffHours > -5.5 && timeDiffHours < 5.5 && !crit.Diameter.StartsWith("_assigned"))
                        {
                            string status = $"KRİTİK ({crit.Stock} ton stok)";
                            CastingEvent casting = new CastingEvent(
                                slotNumber, currentTime, diamKey,
                                CastingTypeEnum.OwnCasting, status);
                            
                            Castings.Add(casting);
                            criticalDict[diamKey + "_assigned"] = crit;  // İşaretle
                            assigned = true;
                            break;
                        }
                    }
                }

                // Boş slot (müşteri dökümü için)
                if (!assigned)
                {
                    CastingEvent casting = new CastingEvent(
                        slotNumber, currentTime, "Boş",
                        CastingTypeEnum.CustomerCasting,
                        "Müşteri dökümü için uygun");
                    
                    Castings.Add(casting);
                }

                currentTime = currentTime.AddHours(CASTING_INTERVAL);
            }

            return Castings;
        }

        public bool AddCustomerCasting(int slotNumber, string diameter, string customerName)
        {
            var casting = Castings.FirstOrDefault(c => c.SlotNumber == slotNumber);
            if (casting != null)
            {
                casting.CustomerName = customerName;
                casting.Diameter = diameter;
                casting.CastingType = CastingTypeEnum.CustomerCasting;
                casting.Status = "Müşteri: " + customerName;
                return true;
            }
            return false;
        }
    }
}
