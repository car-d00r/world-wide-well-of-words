import os
import random
from pathlib import Path
from typing import Union, Optional, cast
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from litestar import Controller, get, post, Litestar, Request
from litestar.static_files import create_static_files_router
from pydantic import BaseModel
from datetime import datetime
from dotenv import load_dotenv

# ======= DB  ========

INIT_DB = text(
    "create table if not exists sentences(sentence text PRIMARY KEY, username text, awarded timestamp NOT NULL, count bigint NOT NULL);"
)

CREATE_SENTENCE = text(
    "insert into sentences (sentence, username, awarded, count) values (:sentence, :username, :awarded, :count);"
)

UPDATE_SENTENCE_COUNT = text(
    "update sentences set count = count + 1 where sentence = :sentence;"
)

GET_SENTENCE_COUNT = text("select count from sentences where sentence = :sentence;")

GET_SUBMISSION_COUNT = text("select SUM(count) from sentences;")

COUNT_UNIQUE_SENTENCES = text("select COUNT(*) from sentences;")

# Top travelers by number of original (first-said) sentences.
LEADERBOARD = text(
    "select username, count(*) as unique_count, coalesce(sum(count), 0) as total_count "
    "from sentences where username is not null "
    "group by username order by unique_count desc, total_count desc limit :limit;"
)

# A random sampling of distinct sentences from the corpus.
RANDOM_SENTENCES = text(
    "select sentence, username, count from sentences order by random() limit :limit;"
)

# Most recently awarded sentences.
RECENT_SENTENCES = text(
    "select sentence, username, count, awarded from sentences order by awarded desc limit :limit;"
)

load_dotenv()
host = os.environ.get("HOST", default="localhost")
port = int(os.environ.get("PORT", default="9091"))
pwd = os.environ.get("PASSWORD", default="PG PWD")
user = os.environ.get("USER", default="PG USER")
database = os.environ.get("DATABASE", default="Sentences")
db_uri = f"postgresql+asyncpg://{user}:{pwd}@{host}:{port}/db"


async def get_connection(app: Litestar):
    if not getattr(app.state, "engine", None):
        app.state.engine = create_async_engine(db_uri)
        async with app.state.engine.begin() as conn:
            await conn.execute(INIT_DB)

    return cast("AsyncEngine", app.state.engine)


async def close_connection(app: Litestar) -> None:
    if getattr(app.state, "engine", None):
        await cast("AsyncEngine", app.state.engine).dispose()


# ======= API ========


class CreateSentenceDTO(BaseModel):
    sentence: str
    username: Optional[str] = None


class UniqueResponse(BaseModel):
    message: str


class NotUniqueResponse(BaseModel):
    message: str
    number_other_submissions: int


class CountResponse(BaseModel):
    count: int
    message: str


class SentenceCountResponse(BaseModel):
    count: int


class SubmissionCount(BaseModel):
    count: int


class LeaderboardEntry(BaseModel):
    username: Optional[str] = None
    unique_count: int
    total_count: int


class RandomSentence(BaseModel):
    sentence: str
    username: Optional[str] = None
    count: int


class RecentSentence(BaseModel):
    sentence: str
    username: Optional[str] = None
    count: int
    awarded: datetime


# TODO: Replace
POSITIVE_MESSAGES = [
    "Never heard it before. The corpus bows to you.",
    "A genuine original — nobody has ever said this.",
    "New words for a weary world. Well done, traveler.",
    "The archive has no record of this. You are the first.",
    "Unheard of. Literally. It's in the ledger now.",
]

# TODO: Replace
NEGATIVE_MESSAGES = [
    "Alas — these words have echoed here before.",
    "Someone beat you to it. The corpus remembers.",
    "Old news, traveler. This has been spoken already.",
    "Not so original after all. It's on record.",
    "The archive recognizes these words. Try again.",
]


def select_positive_message():
    return random.choice(POSITIVE_MESSAGES)


def select_negative_message():
    return random.choice(NEGATIVE_MESSAGES)


class ApiController(Controller):
    path = "/api"

    @post("/sentence")
    async def check_sentence(
        self,
        request: Request,
        data: CreateSentenceDTO,
    ) -> Union[UniqueResponse, NotUniqueResponse]:
        engine = request.app.state.engine
        async with engine.begin() as conn:
            existing = await conn.execute(
                GET_SENTENCE_COUNT, {"sentence": data.sentence}
            )
            row = existing.first()
            if row is None:
                await conn.execute(
                    CREATE_SENTENCE,
                    {
                        "sentence": data.sentence,
                        "username": data.username,
                        "awarded": datetime.now(),
                        "count": 1,
                    },
                )
                return UniqueResponse(message=select_positive_message())

            number_other_submissions = row[0]
            await conn.execute(UPDATE_SENTENCE_COUNT, {"sentence": data.sentence})
            return NotUniqueResponse(
                message=select_negative_message(),
                number_other_submissions=number_other_submissions,
            )

    @get("/sentence-count")
    async def check_sentence_count(self, request: Request) -> SentenceCountResponse:
        engine = request.app.state.engine
        async with engine.connect() as conn:
            result = await conn.execute(COUNT_UNIQUE_SENTENCES)
            sentences_count = result.scalar_one()
        return SentenceCountResponse(count=sentences_count)

    @get("/submission-count")
    async def check_submission_count(self, request: Request) -> SubmissionCount:
        engine = request.app.state.engine
        async with engine.connect() as conn:
            result = await conn.execute(GET_SUBMISSION_COUNT)
            submission_count = result.scalar() or 0
        return SubmissionCount(count=submission_count)

    @get("/leaderboard")
    async def leaderboard(
        self, request: Request, limit: int = 10
    ) -> list[LeaderboardEntry]:
        engine = request.app.state.engine
        async with engine.connect() as conn:
            result = await conn.execute(LEADERBOARD, {"limit": limit})
            rows = result.mappings().all()
        return [LeaderboardEntry(**row) for row in rows]

    @get("/random")
    async def random_sentences(
        self, request: Request, limit: int = 24
    ) -> list[RandomSentence]:
        engine = request.app.state.engine
        async with engine.connect() as conn:
            result = await conn.execute(RANDOM_SENTENCES, {"limit": limit})
            rows = result.mappings().all()
        return [RandomSentence(**row) for row in rows]

    @get("/recent")
    async def recent(self, request: Request, limit: int = 12) -> list[RecentSentence]:
        engine = request.app.state.engine
        async with engine.connect() as conn:
            result = await conn.execute(RECENT_SENTENCES, {"limit": limit})
            rows = result.mappings().all()
        return [RecentSentence(**row) for row in rows]


app = Litestar(
    on_startup=[get_connection],
    on_shutdown=[close_connection],
    route_handlers=[
        ApiController,
        create_static_files_router(
            path="/", directories=[Path(__file__).parent / "static"], html_mode=True
        ),
    ],
)
