"""
Database module — SQLAlchemy models and session management for SQLite.
"""
import json
from datetime import datetime, timezone
from sqlalchemy import (
    create_engine, Column, Integer, Text, Boolean, DateTime, ForeignKey
)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

DATABASE_URL = "sqlite:///bot_data.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class BotRun(Base):
    __tablename__ = "bot_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_date = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    status = Column(Text, nullable=False, default="running")  # running | completed | failed
    current_stage = Column(Integer, default=0)  # 0-5, tracks pipeline progress
    stage_label = Column(Text, default="Initializing...")
    books_processed = Column(Integer, default=0)
    error_log = Column(Text, default="")

    books = relationship("Book", back_populates="run", cascade="all, delete-orphan")


class Book(Base):
    __tablename__ = "books"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, ForeignKey("bot_runs.id"), nullable=False)
    rank = Column(Integer, default=0)
    title = Column(Text, default="")
    author = Column(Text, default="")
    isbn = Column(Text, default="")
    cover_url = Column(Text, default="")
    synopsis = Column(Text, default="")
    subgenre = Column(Text, default="")
    character_archetypes = Column(Text, default="[]")   # JSON array
    visual_keywords = Column(Text, default="[]")        # JSON array
    color_palette = Column(Text, default="[]")          # JSON array of hex codes
    tropes = Column(Text, default="[]")                 # JSON array
    social_momentum = Column(Integer, default=0)
    social_momentum_rationale = Column(Text, default="")
    design_novelty = Column(Integer, default=0)
    design_novelty_rationale = Column(Text, default="")
    audience_size = Column(Integer, default=0)
    audience_size_rationale = Column(Text, default="")
    total_score = Column(Integer, default=0)
    is_sleeper_pick = Column(Boolean, default=False)

    run = relationship("BotRun", back_populates="books")
    concepts = relationship("DesignConcept", back_populates="book", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "run_id": self.run_id,
            "rank": self.rank,
            "title": self.title,
            "author": self.author,
            "isbn": self.isbn,
            "cover_url": self.cover_url,
            "synopsis": self.synopsis,
            "subgenre": self.subgenre,
            "character_archetypes": json.loads(self.character_archetypes or "[]"),
            "visual_keywords": json.loads(self.visual_keywords or "[]"),
            "color_palette": json.loads(self.color_palette or "[]"),
            "tropes": json.loads(self.tropes or "[]"),
            "social_momentum": self.social_momentum,
            "social_momentum_rationale": self.social_momentum_rationale,
            "design_novelty": self.design_novelty,
            "design_novelty_rationale": self.design_novelty_rationale,
            "audience_size": self.audience_size,
            "audience_size_rationale": self.audience_size_rationale,
            "total_score": self.total_score,
            "is_sleeper_pick": self.is_sleeper_pick,
            "concepts": [c.to_dict() for c in self.concepts],
        }


class DesignConcept(Base):
    __tablename__ = "design_concepts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    book_id = Column(Integer, ForeignKey("books.id"), nullable=False)
    concept_name = Column(Text, default="")
    description = Column(Text, default="")
    typography = Column(Text, default="")
    imagery = Column(Text, default="")
    texture = Column(Text, default="")
    color_palette = Column(Text, default="[]")  # JSON array of hex codes
    style = Column(Text, default="")
    format = Column(Text, default="")
    target_audience = Column(Text, default="")
    is_favorite = Column(Boolean, default=False)
    copyright_flag = Column(Boolean, default=False)
    copyright_flag_reason = Column(Text, default="")

    book = relationship("Book", back_populates="concepts")

    def to_dict(self):
        return {
            "id": self.id,
            "book_id": self.book_id,
            "concept_name": self.concept_name,
            "description": self.description,
            "typography": self.typography,
            "imagery": self.imagery,
            "texture": self.texture,
            "color_palette": json.loads(self.color_palette or "[]"),
            "style": self.style,
            "format": self.format,
            "target_audience": self.target_audience,
            "is_favorite": self.is_favorite,
            "copyright_flag": self.copyright_flag,
            "copyright_flag_reason": self.copyright_flag_reason,
        }


# ---------------------------------------------------------------------------
# Initialization
# ---------------------------------------------------------------------------

def init_db():
    """Create all tables if they don't exist."""
    Base.metadata.create_all(bind=engine)


def get_db():
    """Yield a database session (for FastAPI dependency injection)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
