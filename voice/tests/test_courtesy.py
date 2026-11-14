"""What counts as a goodbye said back: thanks, agreements and goodbyes in three languages, and nothing that could change a booking."""

import pytest

from maitre_voice.courtesy import only_courtesy


@pytest.mark.parametrize(
    "said",
    [
        "Merci.",
        "Merci beaucoup, au revoir.",
        "Très bien, merci, bonne soirée.",
        "D’accord, merci.",
        "À vous aussi.",
        "Merci, bonsoir.",
        "Je vous remercie, au revoir madame.",
        "C'est parfait, merci infiniment.",
        "Oui.",
        "À bientôt.",
        "Thanks.",
        "Thank you very much, goodbye.",
        "Okay, thank you, bye bye.",
        "Great, thanks for your help.",
        "You too, have a good one.",
        "Cheers, bye.",
        "That's all, thank you.",
        "Perfect.",
        "See you, take care.",
        "Gracias.",
        "Muchas gracias, adiós.",
        "Vale, gracias, hasta luego.",
        "Igualmente, buenas noches.",
        "Que tenga buena noche.",
        "Perfecto, muchísimas gracias, muy amable.",
        "De acuerdo, gracias a usted.",
        "Sí.",
        "Eso es todo, gracias.",
        "OK.",
    ],
)
def test_a_thanks_an_agreement_or_a_goodbye_is_a_courtesy(said: str):
    assert only_courtesy(said)


@pytest.mark.parametrize(
    "said",
    [
        "",
        "...",
        "Merci, et pour demain ?",
        "Non, demain.",
        "Attendez, une dernière question.",
        "Oui, mais à vingt heures.",
        "Vous avez un parking ?",
        "Bonsoir ?",
        "Au nom de Dupont.",
        "Thanks, but can we make it eight?",
        "No.",
        "Wait, one more thing.",
        "Hello?",
        "Tomorrow.",
        "See you tomorrow.",
        "Yes, for two.",
        "At nine.",
        "Gracias, ¿y tienen terraza?",
        "No, mañana.",
        "Espere, otra cosa.",
        "Sí, pero somos cinco.",
        "¿Hola?",
        "Es tarde.",
        "Hasta mañana.",
        "Las nueve.",
        "4",
    ],
)
def test_anything_that_could_ask_for_something_or_change_a_booking_is_not(said: str):
    assert not only_courtesy(said)
