"""Speech recognition: the words it should expect on the line."""

from maitre_voice.speech import build_tts, keyterms_for, switch_voice


def test_expects_the_restaurants_words_first_then_the_lines_own_in_the_calls_language():
    terms = keyterms_for("es", ("Merrain", "Sopa de cebolla gratinada", "gluten"))
    assert terms[:2] == ["Merrain", "Sopa de cebolla gratinada"]
    assert "alergia" in terms
    assert "allergie" not in terms
    assert terms.count("gluten") == 1


def test_a_caller_who_switches_language_is_answered_by_that_languages_voice(monkeypatch):
    # Agathe speaks French only: asked for Spanish, LiveKit refused every sentence and the call went silent.
    monkeypatch.setenv("LIVEKIT_API_KEY", "test-key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "test-secret")
    engine = build_tts("inference:deepgram/aura-2:agathe", "fr")
    switch_voice(engine, "inference:deepgram/aura-2:carina", "es")
    assert (engine._opts.model, engine._opts.voice, engine._opts.language) == ("deepgram/aura-2", "carina", "es")
