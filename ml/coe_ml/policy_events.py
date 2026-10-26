"""Catalogue of structural policy shocks to the COE market.

These events are the interventions in the Box-Tiao model (interventions.py)
and become known-future inputs to the TFT. Dates are the first bidding month in
which the change applied, cross-checked against LTA / MAS press releases.

Kinds (Box & Tiao, 1975):
  * ``step``      – permanent level shift from ``effective`` onwards
  * ``pulse``     – one-off shock in the ``effective`` month only
  * ``temporary`` – level shift between ``effective`` and ``end`` (inclusive)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class PolicyEvent:
    code: str
    name: str
    effective: date
    kind: str
    categories: str
    description: str
    source_url: str
    end: date | None = None

    def affects(self, category: str) -> bool:
        return category in self.categories


POLICY_EVENTS: list[PolicyEvent] = [
    PolicyEvent(
        code="mas_loan_curbs_2013",
        name="MAS car-loan curbs",
        effective=date(2013, 3, 1),
        kind="step",
        categories="ABE",
        description=(
            "From 26 Feb 2013 car loans were capped at 50-60% of the purchase price "
            "with a maximum 5-year tenure, cutting financed demand for cars."
        ),
        source_url="https://www.mas.gov.sg/regulation/explainers/motor-vehicle-loans",
    ),
    PolicyEvent(
        code="cat_a_power_cap_2014",
        name="Cat A 97kW power cap",
        effective=date(2014, 2, 1),
        kind="step",
        categories="AB",
        description=(
            "From the Feb 2014 exercise Cat A cars must also be at most 97kW (130bhp), "
            "pushing many near-luxury models into Cat B."
        ),
        source_url="https://www.carsandstars.com.sg/engine-power-criterion-to-be-added-in-coe-category-a-cars-from-feb-2014/",
    ),
    PolicyEvent(
        code="mas_loan_easing_2016",
        name="MAS eases car loans",
        effective=date(2016, 6, 1),
        kind="step",
        categories="ABE",
        description=(
            "From 27 May 2016 maximum loan-to-value rose to 60-70% and tenure to 7 years."
        ),
        source_url="https://www.mas.gov.sg/news/media-releases/2016/mas-eases-rules-on-motor-vehicle-financing",
    ),
    PolicyEvent(
        code="zero_growth_2018",
        name="Zero vehicle growth",
        effective=date(2018, 2, 1),
        kind="step",
        categories="ABDE",
        description=(
            "Allowable growth for cars and motorcycles was cut from 0.25% to 0% a year "
            "from Feb 2018, so quota only replaces de-registered vehicles."
        ),
        source_url="https://mothership.sg/2017/10/lta-cuts-vehicle-growth-rate-to-zero-public-transport-to-step-up/",
    ),
    PolicyEvent(
        code="covid_resumption_2020",
        name="Post-lockdown quota release",
        effective=date(2020, 7, 1),
        end=date(2021, 6, 1),
        kind="temporary",
        categories="ABCDE",
        description=(
            "Bidding was suspended during the April-June 2020 circuit breaker; the 19,490 "
            "unallocated COEs were spread over July 2020 to June 2021."
        ),
        source_url="https://www.lta.gov.sg/content/ltagov/en/newsroom/2020/6/news-releases/resumption-of-coe-bidding-exercises-from-6-july.html",
    ),
    PolicyEvent(
        code="ev_reclassification_2022",
        name="EV reclassification (110kW)",
        effective=date(2022, 5, 1),
        kind="step",
        categories="AB",
        description=(
            "From May 2022 fully-electric cars up to 110kW qualify for Cat A (was 97kW), "
            "moving mass-market EV demand from Cat B to Cat A."
        ),
        source_url="https://onemotoring.lta.gov.sg/content/dam/onemotoring/pdf/Circulars%20to%20ESAs/2022/VRL_04_2022.pdf",
    ),
    PolicyEvent(
        code="cut_and_fill_2023",
        name="Quota cut-and-fill smoothing",
        effective=date(2023, 5, 1),
        kind="step",
        categories="AB",
        description=(
            "A one-time adjustment from the second May 2023 exercise brought forward about "
            "6,000 expiring 5-year COEs and spread them over the next few quarters (Cat A quota "
            "+24%, Cat B +15% for the rest of the quarter). It followed the move, from Feb 2023, "
            "to a four-quarter rolling average of de-registrations."
        ),
        source_url="https://lta.gov.sg/content/ltagov/en/newsroom/2023/5/news-releases/one-time_adjustment_to_reduce_volatility.html",
    ),
    PolicyEvent(
        code="quota_injection_2025",
        name="20,000 COE injection",
        effective=date(2025, 2, 1),
        kind="step",
        categories="ABCDE",
        description=(
            "LTA progressively injects up to about 20,000 additional COEs from Feb 2025, "
            "the first net injection in 20 years."
        ),
        source_url="https://www.lta.gov.sg/content/ltagov/en/newsroom/2024/10/news-releases/injection-of-additional-coe-quota-with-reduced-usage---erp-2-0-t.html",
    ),
]

EVENTS_BY_CODE = {event.code: event for event in POLICY_EVENTS}


def indicator(event: PolicyEvent, month: date) -> float:
    """Value of the intervention dummy for ``event`` in bidding month ``month``."""
    if event.kind == "step":
        return 1.0 if month >= event.effective else 0.0
    if event.kind == "pulse":
        return 1.0 if month == event.effective else 0.0
    if event.kind == "temporary":
        assert event.end is not None
        return 1.0 if event.effective <= month <= event.end else 0.0
    raise ValueError(f"unknown intervention kind {event.kind!r}")
