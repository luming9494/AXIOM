"""Weak baseline: a linear classifier cannot represent the XOR decision boundary."""
from torch import nn


def build_model():
    return nn.Linear(2, 2)
