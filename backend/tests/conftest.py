import sys
from pathlib import Path

# this adds the backend folder to the path so that app can be imported when pytest runs from
# backend/ or /app
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
