# Demo listing photos — credits

On 2026-11-18, one Wikimedia Commons photo (1280 px wide) was attached to each of the seven
active demo listings. The photos live in the `listing-images` bucket.

All of these licences require crediting the photographer, and the app has no place to show a
credit. Replace these photos with sellers' own photos (or properly licensed ones) before the
demo listings face real users.

Two photos are close matches rather than exact ones:
- **PlayStation:** the photo shows the original PS5, not the Slim.
- **Monitor:** the photo shows a 34" Dell UltraSharp (U3415W), not a 27" model.

| Listing | Source | Author | Licence |
|---|---|---|---|
| iPhone 13 Pro — 128GB, Graphite | [Apple iPhone 13 Pro and 13 Pro Max.jpg](https://commons.wikimedia.org/wiki/File:Apple_iPhone_13_Pro_and_13_Pro_Max.jpg) | SimonWaldherr | CC BY-SA 4.0 |
| Sony PlayStation 5 Slim (Disc) | [PlayStation 5 and DualSense.jpg](https://commons.wikimedia.org/wiki/File:PlayStation_5_and_DualSense.jpg) | Osh33m | CC BY-SA 4.0 |
| HP EliteBook 840 G8 — i7, 16GB | [HP EliteBook 840 G8.png](https://commons.wikimedia.org/wiki/File:HP_EliteBook_840_G8.png) | Infinatious | CC BY-SA 4.0 |
| Samsung 55" QLED 4K Smart TV | [Samsung QLED TV 8K - 75 inches - 2018-11-02.jpg](https://commons.wikimedia.org/wiki/File:Samsung_QLED_TV_8K_-_75_inches_-_2018-11-02.jpg) | Bretwa | CC BY-SA 4.0 |
| Dell UltraSharp 27" 4K Monitor | [Dell U3415W monitor and Latitude laptop (1).jpg](https://commons.wikimedia.org/wiki/File:Dell_U3415W_monitor_and_Latitude_laptop_(1).jpg) | William Murphy | CC BY-SA 2.0 |
| Nintendo Switch OLED — White | [Nintendo Switch OLED model (white).jpg](https://commons.wikimedia.org/wiki/File:Nintendo_Switch_OLED_model_(white).jpg) | Evan0512 | CC BY-SA 4.0 |
| 2-bed flat, Lekki Phase 1 | [Modern living room with stylish furniture….jpg](https://commons.wikimedia.org/wiki/File:Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg) | Shixart1985 | CC BY 2.0 |

Extra photos were added the same day so the card's swipe-through could be tested:

| Listing | Source | Author | Licence |
|---|---|---|---|
| iPhone 13 Pro — 128GB, Graphite (2 of 3) | [Apple iPhone 13 Pro on MacBook Pro 01.jpg](https://commons.wikimedia.org/wiki/File:Apple_iPhone_13_Pro_on_MacBook_Pro_01.jpg) | SimonWaldherr | CC BY-SA 4.0 |
| iPhone 13 Pro — 128GB, Graphite (3 of 3) | [Apple iPhone 13 Pro on MacBook Pro 03.jpg](https://commons.wikimedia.org/wiki/File:Apple_iPhone_13_Pro_on_MacBook_Pro_03.jpg) | SimonWaldherr | CC BY-SA 4.0 |
| 2-bed flat, Lekki Phase 1 (2 of 2) | [Cozy bedroom with suitcase….jpg](https://commons.wikimedia.org/wiki/File:Cozy_bedroom_with_suitcase_and_natural_light_from_the_window_in_a_modern_apartment_setting.jpg) | Shixart1985 | CC BY 2.0 |

## Seeded store (scripts/seed-my-store.ts, 2026-11-26)

The seed copies the photos above onto its own listings (iPhone, PS5, EliteBook, Samsung TV,
Switch, and the flat's two photos for the Gwarinpa flat and the Wuse shortlet), so the same
credits apply. It also fetched three new photos from Wikimedia Commons:

| Listing | Source | Author | Licence |
|---|---|---|---|
| Toyota Camry XSE 2020 | [2020 Toyota Camry XSE front.jpg](https://commons.wikimedia.org/wiki/File:2020_Toyota_Camry_XSE_front.jpg) | Throwawayacc222 | CC0 (no credit required) |
| Lexus RX 350 2016 | [2016 Lexus RX350, Front Left, 04-05-2021.jpg](https://commons.wikimedia.org/wiki/File:2016_Lexus_RX350,_Front_Left,_04-05-2021.jpg) | SsmIntrigue | CC BY-SA 4.0 |
| Phone & laptop repairs — Gwarinpa | [Réparateur-dépanneur de téléphones mobiles 1.jpg](https://commons.wikimedia.org/wiki/File:R%C3%A9parateur-d%C3%A9panneur_de_t%C3%A9l%C3%A9phones_mobiles_1.jpg) | Karim Diarra | CC BY-SA 4.0 |

`scripts/cleanup-my-store-seed.ts --apply` removes the seeded listings and their photo copies.
