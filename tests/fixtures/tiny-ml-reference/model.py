"""Legal reference modification for task calibration, not an Agent result."""
from torch import nn


def build_model():
    return nn.Sequential(nn.Linear(2, 16), nn.Tanh(), nn.Linear(16, 2))
