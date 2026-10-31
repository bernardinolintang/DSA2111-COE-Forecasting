import sys
from pathlib import Path

# this adds the ml folder to the path so that coe_ml can be imported when pytest runs from ml/ or
# /app
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
