"""When a call follows the caller into another language: on words they keep up in it, never on a few stray ones."""

from maitre_voice.language import CallerLanguage


def test_a_few_stray_words_in_another_language_do_not_move_the_call():
    call = CallerLanguage("es")
    # A name, a dish, or what recognition took for another language in the middle of a call in Spanish.
    assert call.heard("en", "John Smith Junior") is False
    assert call.heard("fr", "le confit de canard") is False
    assert call.language == "es"


def test_a_sentence_in_another_language_moves_the_call_at_once():
    call = CallerLanguage("fr")
    assert call.heard("en", "Hello, do you speak English?") is True
    assert call.language == "en"


def test_short_answers_kept_up_in_another_language_move_it_too():
    call = CallerLanguage("fr")
    assert call.heard("en", "For two people") is False
    assert call.heard("en", "At eight") is True
    assert call.language == "en"


def test_words_in_the_calls_own_language_start_the_count_again():
    call = CallerLanguage("es")
    assert call.heard("en", "John Smith Junior") is False
    assert call.heard("es", "Sí, a ese nombre") is False
    assert call.heard("en", "Smith, with an H") is False
    assert call.language == "es"


def test_a_third_language_starts_from_nothing():
    call = CallerLanguage("fr")
    assert call.heard("en", "For two people") is False
    assert call.heard("es", "A las ocho") is False
    assert call.heard("es", "Para dos") is True
    assert call.language == "es"


def test_a_caller_who_asks_for_a_language_by_name_gets_it_at_once():
    # A tourist on a French line: the answer to "Do you speak English?" is in English, not one turn later.
    for heard_in, said, asked in (
        ("en", "Do you speak English?", "en"),
        ("en", "English, please.", "en"),
        ("en", "English?", "en"),
        ("en", "Sorry, I don't speak French.", "en"),
        ("es", "¿Hablan español?", "es"),
        ("es", "En español, por favor.", "es"),
        ("en", "Do you speak Spanish?", "es"),
        ("es", "¿Habla inglés?", "en"),
    ):
        call = CallerLanguage("fr")
        assert call.heard(heard_in, said) is True, said
        assert call.language == asked, said


def test_a_language_named_for_a_dish_or_in_the_calls_own_language_asks_for_nothing():
    call = CallerLanguage("es")
    assert call.heard("en", "French onion soup") is False
    assert call.heard("fr", "une tarte anglaise") is False
    assert call.language == "es"
    # Asked in the call's own language, it is a question about the menu.
    call = CallerLanguage("fr")
    assert call.heard("fr", "Est-ce que la carte est en anglais ?") is False
    assert call.language == "fr"


def test_one_word_a_thanks_or_a_goodbye_tell_nothing_of_the_language():
    call = CallerLanguage("es")
    for said in ("OK", "Okay, thank you, bye bye.", "Thank you very much, goodbye.", "Perfect, thanks a lot, have a good one."):
        assert call.heard("en", said) is False
    assert call.language == "es"
    # Nor do they start the count again for a caller who is moving to another language.
    assert call.heard("en", "Table for two") is False
    assert call.heard("es", "Gracias") is False
    assert call.heard("en", "At nine please") is True
    assert call.language == "en"


def test_a_language_the_line_does_not_speak_is_left_alone():
    call = CallerLanguage("fr")
    assert call.heard("de", "Guten Abend, ich möchte einen Tisch reservieren") is False
    assert call.heard("", "Hello there, a table for two please") is False
    assert call.language == "fr"


def test_after_moving_the_new_language_is_the_calls_own():
    call = CallerLanguage("fr")
    assert call.heard("en", "Good evening, a table for two tonight please") is True
    assert call.heard("fr", "Pardon, je peux parler français si vous voulez") is True
    assert call.language == "fr"
