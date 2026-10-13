"""Speech recognition: the words it should expect on the line."""

from maitre_voice.speech import keyterms_for


def test_expects_the_restaurants_words_first_then_the_lines_own_in_the_calls_language():
    terms = keyterms_for("es", ("Merrain", "Sopa de cebolla gratinada", "gluten"))
    assert terms[:2] == ["Merrain", "Sopa de cebolla gratinada"]
    assert "alergia" in terms
    assert "allergie" not in terms
    assert terms.count("gluten") == 1
