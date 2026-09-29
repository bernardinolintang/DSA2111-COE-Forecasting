import sys
from pathlib import Path

# Make ``app`` importable when pytest runs from backend/ or /app.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
