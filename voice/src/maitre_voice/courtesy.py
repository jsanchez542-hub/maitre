"""What a caller says back to a goodbye: a thanks, an agreement, a goodbye of their own.

Nobody answers those, and they are said the same whatever language the call is in. The words are the usual
ones in the three languages the line speaks, compared without accents or punctuation. The list is short on
purpose: a day, an hour, a number, a "no" or a "but" are not in it. Said after the goodbye, they may be
changing a booking, and the restaurant answers them.
"""

from __future__ import annotations

import unicodedata
from itertools import product

#: A thanks, a goodbye or an agreement in one word. One of these, or a pair below, makes a few words a courtesy.
_SAYS_IT = frozenset(
    """
    merci remercie ciao oui parfait entendu daccord super egalement pareillement
    thanks thank bye goodbye cheers yes yeah alright perfect great lovely wonderful
    gracias adios chao chau si vale perfecto perfecta genial entendido igualmente
    ok okay okey
    """.split()
)
#: The same in two words: a goodbye, an agreement, or a wish for the rest of the day and its answer.
_SAYS_IT_IN_TWO = frozenset(
    {
        ("au", "revoir"),
        ("a", "bientot"),
        ("vous", "aussi"),
        ("see", "you"),
        ("take", "care"),
        ("you", "too"),
        ("all", "right"),
        ("hasta", "luego"),
        ("hasta", "pronto"),
        ("nos", "vemos"),
        ("de", "acuerdo"),
        *product(("bonne", "bon"), ("soiree", "journee", "nuit", "continuation")),
        *product(("good", "nice", "great", "lovely"), ("day", "evening", "night", "one")),
        *product(("buenas", "buenos", "buen", "buena", "feliz"), ("noches", "noche", "tardes", "tarde", "dias", "dia")),
    }
)
#: Words that only go with them: "je vous remercie", "thanks for your help", "que tenga buena noche".
_GOES_WITH_IT = frozenset(
    """
    je beaucoup bien tres a vous et encore infiniment monsieur madame mademoiselle bonsoir cest note tout pour de votre aide
    you very much so lot and again sir madam maam miss thats all it for your help everything have
    muchas muchisimas mil usted ustedes y muy amable bueno pues venga listo nada mas eso es todo senor senora senorita
    por su ayuda que tenga tengan pase pasen
    """.split()
)


def _words(said: str) -> list[str]:
    """The words as they compare: lower case, without accents, apostrophes or punctuation ("D’accord !" is "daccord")."""
    plain = unicodedata.normalize("NFKD", said.lower())
    kept = "".join(char for char in plain if not unicodedata.combining(char) and char not in "'’")
    return "".join(char if char.isalnum() else " " for char in kept).split()


def only_courtesy(said: str) -> bool:
    """Whether these words are nothing but a thanks, an agreement or a goodbye."""
    words = _words(said)
    says_it = False
    at = 0
    while at < len(words):
        if tuple(words[at : at + 2]) in _SAYS_IT_IN_TWO:
            says_it = True
            at += 2
        elif words[at] in _SAYS_IT:
            says_it = True
            at += 1
        elif words[at] in _GOES_WITH_IT:
            at += 1
        else:
            return False
    return says_it
