"""Train / evaluate / save per-horizon forecast models."""
import json
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from .data import CLIP_MW
from .features import HORIZONS


def feature_cols(f, h):
    other = [c for c in f.columns if (c.startswith("Pcs_f") or c.startswith("elev_f")) and not c.endswith(f"f{h}")]
    return [c for c in f.columns if c not in other]


def _xy(f, targets, valid, h):
    t = targets[h]
    m = valid & t["valid_future"] & t["Pcs_future"].gt(0.3) & t["P_future"].notna() & f["k"].notna()
    X = f.loc[m, feature_cols(f, h)]
    y = (t.loc[m, "P_future"] / t.loc[m, "Pcs_future"].clip(lower=0.3)).clip(0, 1.3)
    return X, y, t.loc[m]


def make_model():
    return HistGradientBoostingRegressor(loss="absolute_error", max_iter=400, learning_rate=0.04,
                                         max_leaf_nodes=24, min_samples_leaf=40, l2_regularization=1.0,
                                         random_state=0)


def to_mw(k_pred, pcs_future):
    return np.clip(k_pred * pcs_future.clip(lower=0.3), 0, CLIP_MW)


def evaluate(f, targets, valid, P15, split, h):
    """Train on data before `split`, test after. P15 = 15-min mean plant power (MW)."""
    X, y, t = _xy(f, targets, valid, h)
    tr, te = X.index < split, X.index >= split
    mdl = make_model().fit(X[tr], y[tr])
    idx = X.index[te]
    truth = t.loc[te, "P_future"]
    pcsf = t.loc[te, "Pcs_future"]
    preds = {
        "persistence": P15.reindex(idx),                       # next = last 15 min
        "smart_persistence": to_mw(f.loc[idx, "k"], pcsf),     # same cloudiness, sun moves
    }
    preds["model"] = pd.Series(to_mw(mdl.predict(X[te]), pcsf), index=truth.index)
    rows = {}
    for name, p in preds.items():
        e = (p - truth).dropna()
        rows[name] = {"MAE_MW": e.abs().mean(), "RMSE_MW": np.sqrt((e ** 2).mean()), "bias_MW": e.mean(), "n": len(e)}
    res = pd.DataFrame(rows).T
    res["skill_vs_persistence_%"] = 100 * (1 - res["RMSE_MW"] / res.loc["persistence", "RMSE_MW"])
    return res, mdl, pd.DataFrame({"truth": truth, **{k: v for k, v in preds.items()}})


def fit_all(f, targets, valid):
    models = {}
    for h in HORIZONS:
        X, y, _ = _xy(f, targets, valid, h)
        models[h] = (make_model().fit(X, y), list(X.columns))
    return models


def save(models, meta, path):
    joblib.dump({"models": models, "meta": meta}, path)


def load(path):
    return joblib.load(path)
