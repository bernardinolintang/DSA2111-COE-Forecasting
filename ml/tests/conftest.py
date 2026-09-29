import sys
from pathlib import Path

# Make ``coe_ml`` importable when pytest runs from the ml/ directory or /app.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
