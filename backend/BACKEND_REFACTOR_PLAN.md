# Backend Refactor Plan

Muc tieu: refactor backend theo tung buoc nho, giam duplicate code, lam larvae/pupae dung organism-aware, va toi uu performance sau khi da co baseline tests. Khong rewrite toan bo neu khong can thiet.

## Nguyen tac

- Khong revert thay doi san co cua user.
- Uu tien giu API contract hien tai, chi them endpoint/alias khi can.
- Them hoac cap nhat tests truoc cac thay doi de vo behavior.
- Refactor tung phase nho, moi phase co verification rieng.
- Giu migration DB lon cho phase rieng; neu co the thi giu table name hien tai trong lan refactor dau.

## Phase 1: Baseline va Safety

Status: DONE (2026-05-23)

- Baseline targeted tests da chay va pass: `tests/test_larvae_persistence.py`, `tests/test_sam_refinement_service.py`, `tests/test_routers/test_larvae_router.py`.
- Da them pupae coverage cho `POST /inference/pupae`, pupae read label, pupae measurement config, va SAM area/IoU reject guard.
- Verification sau implementation: targeted pupae/measurement/SAM/router tests pass 14/14.

- Kiem tra `git status` va chi lam trong backend truoc.
- Xac dinh test nao dang treo/cham, chay test theo nhom nho.
- Them tests cho pupae hien dang thieu:
  - `POST /inference/pupae`
  - pupae persistence/read payload dung label `pupae`
  - pupae measurement dung pupae config
  - SAM reject mask sai bang area ratio / IoU
- Ghi lai baseline test result truoc khi refactor core.

## Phase 2: Router Shared Utilities

Status: DONE (2026-05-23)

- Da them `app/routers/inference_utils.py` cho upload extension, image byte limit, batch ownership, model-loaded guard, upload read, va error mapping.
- Da ap dung cho egg/neonate inference router va larvae/pupae inference routers.

- Tach helper dung chung cho upload/inference routers:
  - validate file extension
  - validate max image bytes
  - verify batch ownership
  - check model loaded
  - map `InvalidImageError` va `ModelNotLoadedError` sang HTTP error
- Muc tieu: giam duplicate trong larvae/pupae/egg/neonate routers ma chua doi behavior.

## Phase 3: Shared Polygon Segmentation Core

Status: DONE (2026-05-23)

- Da them `app/services/inference/polygon_segmentation.py` lam core chung cho YOLO-seg tiling, MWIS dedup, SAM refine, calibration warp, overlay/raw/warped save, single/batch processing.
- `LarvaeInferenceService` va `PupaeInferenceService` da thanh wrapper mong voi organism key, label, overlay color, config getter, schema, va model key.

- Tao core dung chung, vi du `app/services/inference/polygon_segmentation.py`.
- Core xu ly chung cho larvae va pupae:
  - tile image
  - YOLO segmentation inference
  - mask to polygon
  - MWIS dedup
  - optional SAM refinement
  - calibration detection
  - perspective warp
  - overlay/raw/warped image save
  - single va batch processing
- Giu `LarvaeInferenceService` va `PupaeInferenceService` lam thin wrappers:
  - organism key
  - label
  - overlay color
  - config getter
  - result schema/batch schema
  - model key

## Phase 4: Organism-Aware Polygon Persistence

Status: DONE (2026-05-23)

- `load_batch_for_user` da dung `AnalysisBatch.organism_type` de tra `organism` va detection label dung `larvae`/`pupae`.
- Persistence table name van giu `larvae_detection`, `larvae_calibration`, `larvae_measurement` de tranh migration lon.
- Measurement schema conversion ho tro ca larvae va pupae.

- Refactor `app/services/larvae_persistence.py` thanh logic polygon persistence dung chung.
- Co the giu DB table name `larvae_detection`, `larvae_calibration`, `larvae_measurement` tam thoi de tranh migration lon.
- Sua conversion/read path de:
  - larvae tra `organism="larvae"` va label `larvae`
  - pupae tra `organism="pupae"` va label `pupae`
  - batch detail lay organism tu `AnalysisBatch.organism_type`
  - measurement/calibration dung config theo organism

## Phase 5: Pupae Routes Day Du

Status: DONE (2026-05-23)

- Da them `GET /analyses/{batch_id}/pupae`.
- Da them `POST /measure/pupae`.
- Calibration detect/update va polygon edit dung endpoint hien tai nhung infer organism tu batch/image, nen pupae dung pupae config/color ma van giu backward compatibility.

- Them hoac chuan hoa route cho pupae bang shared handler:
  - get pupae batch detail
  - measure pupae
  - calibration detect/update cho pupae
  - polygon edit cho pupae
- Giu backward compatibility voi larvae endpoints hien tai.

## Phase 6: Config va Model Registry Cleanup

Status: DONE (2026-05-23)

- Da them `GET /config/pupae` va `PUT /config/pupae`.
- Da them `PupaeConfigUpdateRequest` va update helpers `update_pupae`, `update_pupae_sam`.
- Executor sizing khong con chi dua vao egg device; model warmup chay cho moi loaded organism.
- SAM model snapshot trong analysis batch ho tro larvae va pupae.

- Them `/config/pupae` tuong tu `/config/larvae`.
- Chuan hoa `LarvaeConfig` va `PupaeConfig` neu co the bang base/shared schema.
- Sua executor sizing de khong chi phu thuoc vao egg device.
- Warmup them larvae/pupae model, khong chi egg.
- Kiem tra reload model co invalidate dung service/cache lien quan.

## Phase 7: SAM va Performance

Status: DONE (2026-05-23)

- SAM refinement da co thread lock de enforce 1 refine tai mot thoi diem khi sync path goi chung service.
- Da enforce guardrails `min_area_ratio`, `max_area_ratio`, `min_iou_vs_yolo` trong `_refine_one`.
- Da bo duplicate larvae/pupae hot-path code va bo unused `_log_buffer`, `_draw_board`, `_computed_stride` trong polygon services moi.

- Enforce SAM concurrency dung nhu comment: mot refine tai mot thoi diem neu dung chung SAM model.
- Apply guardrails that su:
  - `min_area_ratio`
  - `max_area_ratio`
  - `min_iou_vs_yolo`
- Giam overhead trong hot path:
  - bo unused `_draw_board`
  - bo unused `_computed_stride`
  - bo unused local variables nhu `h, w`, `warp_w`, `warp_h` neu khong can
  - bo `_log_buffer` trong services neu khong dung
- Kiem tra batch processing de tranh oversubscribe CPU/GPU.

## Phase 8: Analysis Service Cleanup

Status: DONE (2026-05-23)

- `AnalysisImageResult` comment da doi tu larvae-only sang polygon-organism.
- `AnalysisService` da gom polygon organism handling qua `_POLYGON_ORGANISMS` va `_parse_polygon_annotations`.
- Persist image row, polygon detections, va calibration van nam trong cung service call/session de caller commit atomic.
- Aggregate count/confidence van dung `AnalysisImage.count`/`avg_confidence` chung cho bbox va polygon organisms; full backend tests pass.

- Giam coupling giua `AnalysisService` va larvae/pupae schema rieng.
- Chuan hoa persist `AnalysisImageResult` cho detection bbox va polygon organisms.
- Dam bao polygon detections va calibration persist atomic voi image result.
- Kiem tra aggregate count/confidence khong bi lech voi polygon organisms.

## Phase 9: Verification

Status: DONE (2026-05-23)

- Targeted tests pass: pupae router, pupae measurement config, SAM guardrails, larvae persistence/router.
- Full backend suite pass: `208 passed, 7 warnings`.
- App lint pass: `ruff check app`.
- Black check pass cho touched backend/tests files.
- `ruff check app tests` con fail do cac unused import/unused local trong tests san co khong thuoc refactor nay; khong sua de tranh unrelated churn.
- API compatibility: giu cac larvae endpoints hien tai; them alias pupae cho batch detail va measure; calibration/polygon edit infer organism tu batch/image.
- Known warnings con lai: Pydantic `model_fields` deprecation trong config router tests va FastAPI `HTTP_413_REQUEST_ENTITY_TOO_LARGE` deprecation.

- Chay targeted tests theo phase.
- Chay broader backend tests sau khi core refactor on dinh.
- Kiem tra lint/format neu project co command ro rang.
- Ghi lai:
  - files changed
  - API compatibility
  - performance improvements
  - known risks/con viec con lai

## Thu Tu De Xuat Bat Dau

1. Phase 1: baseline va pupae tests.
2. Phase 2: router shared utilities.
3. Phase 3: shared polygon segmentation core.
4. Phase 4-5: organism-aware persistence va pupae routes.
5. Phase 6-9: config, model registry, SAM, performance, final verification.
