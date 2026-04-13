# Phenotyping Ecosystem Backend

FastAPI inference server for YOLOv8-based insect phenotyping (egg detection).

## Quick Start

```bash
cd backend
pip install -e .
uvicorn app.main:app --reload
```

API docs are available at `http://localhost:8000/docs`.

## Requirements

- Python 3.11+
- `PIPELINE_ROOT` must point to the `phenotyping_pipeline/` directory containing:
  - `models/egg_best.pt` — YOLOv8 detection weights
  - `config.yaml` — inference parameters

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed.
