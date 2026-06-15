from datetime import datetime, timedelta
from enum import Enum

class DiameterType(Enum):
    D127 = ("127", 13, 20)  # çap, günlük ton, hazırlık saati
    D178 = ("178", 20, 24)
    D203 = ("203", 24, 24)
    D254 = ("254", 36, 24)

class CastingType(Enum):
    OWN = "Kendi Döküm"
    CUSTOMER = "Müşteri Döküm"

class CastingEvent:
    def __init__(self, diameter: str, slot_number: int, scheduled_time: datetime, 
                 casting_type: CastingType, status: str = "Planlandı"):
        self.diameter = diameter
        self.slot_number = slot_number
        self.scheduled_time = scheduled_time
        self.casting_type = casting_type
        self.status = status
        self.customer_name = None
    
    def __repr__(self):
        return (f"[{self.scheduled_time.strftime('%a %d/%m %H:%M')}] "
                f"{self.diameter}mm - {self.casting_type.value} - {self.status}")

class CastingPlanner:
    CASTING_INTERVAL = 11  # saat
    WEEK_HOURS = 168
    
    DIAMETERS = {
        "127": DiameterType.D127,
        "178": DiameterType.D178,
        "203": DiameterType.D203,
        "254": DiameterType.D254,
    }
    
    def __init__(self):
        self.castings = []
        self.stocks = {"127": 0, "178": 0, "203": 0, "254": 0}
    
    def set_stocks(self, stocks_dict):
        """Stok bilgisini güncelle (ton cinsinden)"""
        self.stocks = stocks_dict.copy()
    
    def calculate_critical_times(self):
        """Her çap için kritik döküm zamanlarını hesapla"""
        now = datetime.now()
        week_end = now + timedelta(hours=self.WEEK_HOURS)
        
        critical_castings = []
        
        for diameter_key, diameter_info in self.DIAMETERS.items():
            stock = self.stocks[diameter_key]
            daily_usage = diameter_info.value[1]  # ton/gün
            prep_hours = diameter_info.value[2]   # hazırlık saati
            
            # Malzeme kaç gün yetecek?
            days_until_empty = stock / daily_usage if daily_usage > 0 else float('inf')
            
            # Boş olmadan kaç saat kaldı?
            hours_until_empty = days_until_empty * 24
            
            # Döküm zamanı: bitiminden prep_hours saat öncesi
            casting_time_hours = hours_until_empty - prep_hours
            
            if casting_time_hours > 0 and casting_time_hours < self.WEEK_HOURS:
                critical_time = now + timedelta(hours=casting_time_hours)
                critical_castings.append({
                    "diameter": diameter_key,
                    "time": critical_time,
                    "hours_until_critical": casting_time_hours,
                    "stock": stock,
                    "daily_usage": daily_usage
                })
        
        # Kritik zamanları saate göre sırala
        critical_castings.sort(key=lambda x: x["hours_until_critical"])
        
        return critical_castings
    
    def generate_weekly_plan(self):
        """Haftalık plan oluştur"""
        now = datetime.now()
        # Başlangıç saatini 11:00 yapalım (veya şu anki saati yuvarla)
        start_time = now.replace(minute=0, second=0, microsecond=0)
        
        self.castings = []
        slot_number = 0
        
        current_time = start_time
        week_end = start_time + timedelta(hours=self.WEEK_HOURS)
        
        critical_castings = self.calculate_critical_times()
        critical_dict = {c["diameter"]: c for c in critical_castings}
        
        # Her 11 saatte bir slot
        while current_time < week_end:
            slot_number += 1
            
            # Hangi çap için kritik slot?
            assigned = False
            for diameter in ["127", "178", "203", "254"]:
                if diameter in critical_dict:
                    crit = critical_dict[diameter]
                    # Kritik zamanın ±5.5 saati içindeyse, bu slotu ayır
                    time_diff = (current_time - crit["time"]).total_seconds() / 3600
                    if -5.5 < time_diff < 5.5 and crit.get("slot_assigned") is None:
                        casting = CastingEvent(
                            diameter=diameter,
                            slot_number=slot_number,
                            scheduled_time=current_time,
                            casting_type=CastingType.OWN,
                            status=f"KRİTİK ({crit['stock']:.1f}ton stok)"
                        )
                        self.castings.append(casting)
                        critical_dict[diameter]["slot_assigned"] = slot_number
                        assigned = True
                        break
            
            # Eğer hiçbir kritik döküm yoksa boş slot (müşteri dökümü için)
            if not assigned:
                casting = CastingEvent(
                    diameter="Boş",
                    slot_number=slot_number,
                    scheduled_time=current_time,
                    casting_type=CastingType.CUSTOMER,
                    status="Müşteri dökümü için uygun"
                )
                self.castings.append(casting)
            
            current_time += timedelta(hours=self.CASTING_INTERVAL)
        
        return self.castings
    
    def add_customer_casting(self, slot_number: int, diameter: str, customer_name: str):
        """Müşteri dökümü ekle"""
        for casting in self.castings:
            if casting.slot_number == slot_number:
                casting.customer_name = customer_name
                casting.diameter = diameter
                casting.casting_type = CastingType.CUSTOMER
                casting.status = "Müşteri: " + customer_name
                return True
        return False
    
    def get_summary(self):
        """Haftalık özet"""
        summary = []
        summary.append("=" * 80)
        summary.append("HAFTALIK DÖKÜM PLANI - DÖKÜM MAKİNASI")
        summary.append("=" * 80)
        
        for casting in self.castings:
            day_name = casting.scheduled_time.strftime("%A (Pazartesi=Seg)")
            date_str = casting.scheduled_time.strftime("%d/%m/%Y")
            time_str = casting.scheduled_time.strftime("%H:%M")
            
            summary.append(
                f"Slot {casting.slot_number:2d} | {day_name:10s} {date_str} {time_str:>5s} | "
                f"{casting.diameter:>4s}mm | {casting.casting_type.value:15s} | {casting.status}"
            )
        
        summary.append("=" * 80)
        return "\n".join(summary)
