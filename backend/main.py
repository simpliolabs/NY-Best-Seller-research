"""
FastAPI application — the API server for the NYT Romance Design Research Bot.
"""
from fastapi import FastAPI, BackgroundTasks, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database import init_db, get_db, BotRun, Book, DesignConcept

# ---------------------------------------------------------------------------
# App Initialization
# ---------------------------------------------------------------------------

app = FastAPI(
    title="NYT Romance Design Research Bot",
    description="Weekly automated design research agent for print-on-demand apparel.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------

class FavoriteRequest(BaseModel):
    is_favorite: bool


# ---------------------------------------------------------------------------
# Health Check
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Pipeline Trigger
# ---------------------------------------------------------------------------

@app.post("/api/run")
async def trigger_run(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    # Prevent overlapping runs
    active = db.query(BotRun).filter(BotRun.status == "running").first()
    if active:
        raise HTTPException(status_code=409, detail="A run is already in progress.")

    new_run = BotRun(status="running", current_stage=0, stage_label="Initializing...")
    db.add(new_run)
    db.commit()
    db.refresh(new_run)

    # Import here to avoid circular imports
    from pipeline.orchestrator import run_full_pipeline
    background_tasks.add_task(run_full_pipeline, new_run.id)

    return {"status": "started", "run_id": new_run.id}


# ---------------------------------------------------------------------------
# Run Status
# ---------------------------------------------------------------------------

@app.get("/api/status")
def get_status(db: Session = Depends(get_db)):
    latest = db.query(BotRun).order_by(BotRun.run_date.desc()).first()
    if not latest:
        return {"status": "no_runs", "message": "No pipeline runs yet."}
    return {
        "run_id": latest.id,
        "status": latest.status,
        "current_stage": latest.current_stage,
        "stage_label": latest.stage_label,
        "books_processed": latest.books_processed,
        "run_date": latest.run_date.isoformat() if latest.run_date else None,
        "error_log": latest.error_log,
    }


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

@app.get("/api/reports")
def list_reports(db: Session = Depends(get_db)):
    runs = db.query(BotRun).order_by(BotRun.run_date.desc()).all()
    results = []
    for r in runs:
        top_pick = (
            db.query(Book)
            .filter(Book.run_id == r.id)
            .order_by(Book.total_score.desc())
            .first()
        )
        results.append({
            "run_id": r.id,
            "run_date": r.run_date.isoformat() if r.run_date else None,
            "status": r.status,
            "books_processed": r.books_processed,
            "top_pick_title": top_pick.title if top_pick else None,
        })
    return results


@app.get("/api/reports/{run_id}")
def get_report(run_id: int, db: Session = Depends(get_db)):
    run = db.query(BotRun).filter(BotRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found.")

    books = (
        db.query(Book)
        .filter(Book.run_id == run_id)
        .order_by(Book.total_score.desc())
        .all()
    )

    return {
        "run_id": run.id,
        "run_date": run.run_date.isoformat() if run.run_date else None,
        "status": run.status,
        "books_processed": run.books_processed,
        "books": [b.to_dict() for b in books],
    }


# ---------------------------------------------------------------------------
# Book Detail
# ---------------------------------------------------------------------------

@app.get("/api/books/{book_id}")
def get_book(book_id: int, db: Session = Depends(get_db)):
    book = db.query(Book).filter(Book.id == book_id).first()
    if not book:
        raise HTTPException(status_code=404, detail="Book not found.")
    return book.to_dict()


# ---------------------------------------------------------------------------
# Favorites
# ---------------------------------------------------------------------------

@app.post("/api/concepts/{concept_id}/favorite")
def toggle_favorite(concept_id: int, body: FavoriteRequest, db: Session = Depends(get_db)):
    concept = db.query(DesignConcept).filter(DesignConcept.id == concept_id).first()
    if not concept:
        raise HTTPException(status_code=404, detail="Concept not found.")
    concept.is_favorite = body.is_favorite
    db.commit()
    return {"success": True, "concept_id": concept_id, "is_favorite": concept.is_favorite}


@app.get("/api/favorites")
def list_favorites(
    format_filter: Optional[str] = Query(None, alias="format"),
    style_filter: Optional[str] = Query(None, alias="style"),
    subgenre_filter: Optional[str] = Query(None, alias="subgenre"),
    db: Session = Depends(get_db),
):
    query = (
        db.query(DesignConcept)
        .join(Book)
        .filter(DesignConcept.is_favorite == True)
    )
    if format_filter:
        query = query.filter(DesignConcept.format.ilike(f"%{format_filter}%"))
    if style_filter:
        query = query.filter(DesignConcept.style.ilike(f"%{style_filter}%"))
    if subgenre_filter:
        query = query.filter(Book.subgenre.ilike(f"%{subgenre_filter}%"))

    concepts = query.all()
    results = []
    for c in concepts:
        d = c.to_dict()
        d["book_title"] = c.book.title if c.book else ""
        d["book_author"] = c.book.author if c.book else ""
        d["book_subgenre"] = c.book.subgenre if c.book else ""
        results.append(d)
    return results
