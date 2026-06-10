// Internationalization (i18n) support — German only
const translations = {
    de: {
        // Page title and header
        pageTitle: "BRICKONAS Mosaik BrickPic",

        // Step navigation (3-step visual flow)
        stepperConfigure: "Anpassen",
        stepperColors: "Farben",
        stepperResult: "Ergebnis",
        step1Label: "Bild & Einstellungen",
        step2Label: "Dein Mosaik",
        nextRefine: "Weiter: Farben verfeinern \u2192",
        nextOutput: "Weiter: Ergebnis \u2192",
        backConfigure: "\u2190 Zurück: Anpassen",
        backRefine: "\u2190 Zurück: Farben verfeinern",
        refineColorsSubtitle: "Bearbeite einzelne Pixel mit dem Pinsel, um dein Mosaik zu perfektionieren",

        // Step references (used by processing code and UI headers)
        step1Crop: "Zuschneiden",
        step2Adjust: "Anpassen",
        step3Colors: "Farben verfeinern",
        step4Output: "Ergebnis",
        step1: "Schritt 1",
        step2: "Schritt 2",
        step3: "Schritt 3",
        step4: "Ergebnis",
        step2Header: "Anpassen",
        step3Header: "Farben verfeinern",
        step4Header: "Ergebnis",

        // Step subtitles
        step1DepthSubtitle: "Tiefenkarte erhalten",
        step1DepthSubtitle2: "Tiefenkarten-Zuschnitt entspricht dem Eingabebild",
        step2Subtitle: "Farben und Einstellungen anpassen",
        step2DepthSubtitle: "Tiefe diskretisieren",
        step3Subtitle: "Bearbeite einzelne Pixel, um dein Mosaik zu perfektionieren",
        step3DepthSubtitle: "Tiefenkarte anpassen",
        step4Subtitle: "Dein fertiges BRICKONAS Klemmbaustein-Mosaik",

        // Navigation buttons
        nextAdjust: "Weiter: Farben anpassen →",
        nextColors: "Weiter: Farben →",
        nextOutput: "Weiter: Ergebnis →",
        backCrop: "← Zurück: Zuschneiden",
        backAdjust: "← Zurück: Anpassen",
        backColors: "← Zurück: Farben",
        createMosaic: "Mosaik erstellen",
        backToSettings: "← Zurück zu Einstellungen",

        // Resolution section
        resolution: "Auflösung",
        targetResolution: "Zielauflösung:",
        resolutionStepWidth: "Auflösungsschritt Breite (Plattengröße):",
        resolutionStepHeight: "Auflösungsschritt Höhe (Plattengröße):",
        width: "Breite (Noppenanzahl):",
        height: "Höhe (Noppenanzahl):",

        // Input Image section
        inputImage: "Eingabebild",
        supportedFormats: "Unterstützte Bildformate hängen von der Kompatibilität Ihres Browsers ab",
        transparencyWarning: "Aufgrund der Art der Lego Art Sets werden Bilder mit Transparenz nicht vollständig unterstützt",

        // Depth section
        depth: "Tiefe",
        depthThreshold: "Tiefenschwelle",
        depthThresholds: "Tiefenschwellen",
        numDepthLevels: "Anz. Tiefenstufen",

        // Get Started section
        getStarted: "Loslegen",
        uploadImage: "Bild hochladen",
        pasteImage: "Bild einfügen",
        exampleImage: "Beispielbild",
        orPasteImage: "Oder fügen Sie ein Bild aus der Zwischenablage ein",

        // HSV section
        hsv: "HSV",
        hueAdjustment: "Farbton-Anpassung:",
        saturationAdjustment: "Sättigungs-Anpassung:",
        valueAdjustment: "Wert-Anpassung:",
        resetHSV: "HSV zurücksetzen",

        // Color Adjustment section
        colorAdjustment: "Farbanpassung",
        hue: "Farbton",
        saturation: "Sättigung",
        brightness: "Helligkeit",
        contrast: "Kontrast",
        value: "Wert",
        clearOverrides: "Überschreibungen löschen",
        brightnessAdjustment: "Helligkeits-Anpassung:",
        contrastAdjustment: "Kontrast-Anpassung:",
        resetBrightness: "Helligkeit zurücksetzen",
        resetContrast: "Kontrast zurücksetzen",

        // Interpolation section
        interpolation: "Interpolation",
        interpolationAlgorithm: "Interpolationsalgorithmus",
        default: "Standard",
        maxPooling: "Max Pooling",
        minPooling: "Min Pooling",
        avgPooling: "Durchschnitts-Pooling",
        dualMinMaxPooling: "Dual Min-Max Pooling",

        // Color tab
        color: "Farbe",

        // Available Colors/Studs section
        availableStuds: "Verfügbare Noppen",
        availableColors: "Verfügbare Farben",
        colorPalette: "Farbpalette",
        useInfiniteStuds: "Unendliche Noppen verwenden",
        studType: "Noppentyp",
        clearAvailablePieces: "Verfügbare Teile löschen",
        pixelPiece: "Pixel-Teil",

        // Refine Colors section
        refineColors: "Farben verfeinern",
        eraserSize: "Radiergröße",
        eraser: "Radierer",
        paintbrush: "Pinsel",
        clearColorOverrides: "Farbüberschreibungen löschen",

        // Refine Depth section
        refineDepth: "Tiefe verfeinern",
        editDepth: "Tiefe bearbeiten",
        clearDepthOverrides: "Tiefenüberschreibungen löschen",
        clickPixelIncrease: "● Klicken Sie auf ein Pixel, um seine Höhe zu erhöhen",
        clickPixelDecrease: "● Klicken Sie auf ein Pixel, um seine Höhe zu verringern",

        // Output section
        piecesUsed: "Verwendete Teile",
        missingPieces: "Fehlende Teile",
        downloadInstructions: "Anleitung herunterladen",
        instructions: "Anleitungen",
        generateInstructions: "Farbanleitung PDF erstellen",
        generateInstructionsPDF: "Anleitung PDF erstellen",
        generateDepthInstructions: "Tiefenanleitung PDF erstellen",
        generateDepthInstructionsPDF: "Tiefenanleitung PDF erstellen",
        highQuality: "Hohe Qualität",
        highQualityPdf: "Hohe Qualität PDF",
        orderMosaic: "Bestellen",
        orderMosaicHint: "Wir erstellen dein individuelles Mosaik aus hochwertigen LEGO®-kompatiblen Steinen und senden es dir zu.",
        orderEmailSending: "Bestelldetails werden gesendet...",
        orderEmailSent: "Bestelldetails erfolgreich gesendet!",
        orderEmailError: "Fehler beim Senden der Bestelldetails.",
        copyBricklinkXML: "Bricklink XML in Zwischenablage kopieren",
        bricklinkUploadPage: "Bricklink Upload-Seite",
        usPickABrickPage: "U.S. Pick a Brick Seite",

        // 3D Preview
        preview3D: "3D-Vorschau",
        preview3DHelp: "Wenn Sie den 3D-Effekt nicht sehen können, wenn Sie mit der Maus über das Bild fahren, überprüfen Sie die Eingabe von Tiefenschritt 1",

        // Depth section - Step 1
        select: "Auswählen",
        selectDepthMapImage: "Tiefenkartenbild auswählen",
        selectDepthMapHelp: "Wenn Sie eine Tiefenkarte haben, die Ihrem Bild entspricht, können Sie sie hier auswählen. Wenn nicht, können Sie im Abschnitt 'Generieren' eine Annäherung erstellen.",
        generate: "Generieren",
        computeUsingDNN: "Mit DNN berechnen",
        computeDepthMapHelp: "Dies berechnet eine Annäherung der Tiefenkarte, wenn Sie keine haben",
        computeDepthMapWarning: "Die Berechnung der Tiefenkarte kann rechenintensiv sein. Seien Sie bereit, etwas zu warten, und seien Sie vorsichtig, besonders wenn Sie ein weniger leistungsfähiges Gerät haben.",
        howDoesThisWork: "Wie funktioniert das?",
        dnnExplanation: "Die Tiefenkarte wird mit einem DNN (Deep Neural Network) berechnet. Aus den im Abschnitt 'Über' beschriebenen Gründen wird alles vollständig im Browser ausgeführt, unter Verwendung einer modifizierten Version von ONNX.js. Das verwendete Modell ist MiDaS.",
        citationForModel: "Zitat für verwendetes Modell",
        important: "Wichtig",

        // Step 1 subtitle
        step1Subtitle: "Eingabebild zuschneiden + skalieren",

        // Interpolation
        interpolationHelp: "Diese Einstellung bestimmt, welcher Algorithmus verwendet wird, um das Bild auf die Zielauflösung zu skalieren",
        browserDefault: "Browser-Standard",

        // Level Count and Thresholds
        levelCount: "Stufenanzahl",
        numberOfDepthLevels: "Anzahl der Tiefenstufen:",
        depthLevelsHelp: "Bestimmt, wie viele diskrete Tiefenstufen die Pixel des Bildes haben sollen, wobei jede Stufe eine Lego-Platte tief ist",
        thresholds: "Schwellenwerte",
        troubleshooting: "Fehlerbehebung",
        troubleshootingHelp: "Wenn die diskretisierte Tiefenkarte leer ist, stellen Sie sicher, dass Sie in Schritt 1 eine Tiefenkarte ausgewählt oder berechnet haben, und passen Sie die Schwellenwerte so an, dass sie zwischen den Abschnitten des Bildes liegen, die Sie trennen möchten",

        // Tools
        dropper: "Pipette",

        // Available Colors help
        availableColorsHelp1: "● In diesem Abschnitt wird angegeben, wie viele Teile jeder Farbe Sie zur Verfügung haben, um das Bild zu erstellen",
        availableColorsHelp2: "● Farbnamen sind Bricklink-Farben",
        availableColorsHelp3: "● Der Algorithmus kann nur ausgeführt werden, wenn Sie genügend Teile ausgewählt haben ('Fehlende Teile' muss 0 sein)",
        availableColorsHelp4: "● Wenn Sie mit einem vorhandenen Set arbeiten, löschen Sie die verfügbaren Teile und verwenden Sie die Misch-Option, um die Teile aus Ihrem Set hinzuzufügen.",
        requiredPieces: "Erforderliche Teile:",
        availablePieces: "Verfügbare Teile:",
        missingPiecesLabel: "Fehlende Teile:",
        infinitePieceCounts: "Unendliche Teileanzahl",
        infinitePieceCountsWarning: "Wichtig: Unendliche Teileanzahlen wurden verwendet, da ein linearer Fehlerdithering-Algorithmus im Abschnitt 'Quantisierung' ausgewählt wurde oder ein variabler Teiltyp im Abschnitt 'Pixel-Teil' ausgewählt wurde",
        paintbrushNote: "Hinweis: Alle mit dem Pinsel gemalten Farben werden als vorhanden angenommen, wenn unendliche Teileanzahlen aktiviert sind",
        numberAvailable: "Anzahl verfügbar",
        addStud: "+ Noppe hinzufügen",
        exportSelectedStuds: "Ausgewählte Noppen exportieren",
        mixInStuds: "Noppen aus vorhandenem Set mischen",
        mixedInStudsNote: "Gemischte Noppen werden zu bereits ausgewählten Noppen hinzugefügt",
        matchPixelPieceNote: "Stellen Sie sicher, dass das Set, aus dem Sie Noppen mischen, zum ausgewählten Pixel-Teil passt",
        importFromFile: "Aus Datei importieren",

        // Step 4 Pieces Used
        missingPiecesWarning: "'Fehlende Teile' unter 'Verfügbare Farben' muss 0 sein",
        piecesUsedInFinalImage: "Im Endbild verwendete Teile",
        dimensions: "Abmessungen",
        numberUsed: "Anzahl verwendet",
        piecesMissingFromStep3: "Fehlende Teile aus der Farbzuordnung",
        addingPiecesHelp: "Das Hinzufügen dieser Teile ermöglicht es, dass das Endbild dem Vorschaubild entspricht",
        numberMissing: "Anzahl fehlend",

        // Instructions section
        instructionsSplitNote: "Längere Anleitungen können in mehrere Dateien aufgeteilt werden",
        colorNamesAreBricklink: "Farbnamen sind Bricklink-Farben",
        pdfGenerationWarning: "Je nach Hardware und gewählter Auflösung kann die PDF-Erstellung einige Sekunden dauern. Seien Sie bereit zu warten, wenn Sie Anleitungen für größere Auflösungen erstellen.",

        // Get Started
        inputSet: "Eingabe-Set",
        inputPieces: "Eingabe-Teile:",
        inputPiecesTooltip: "Dies kann auch später Teil für Teil geändert oder angepasst werden",
        selectInputImage: "Eingabebild auswählen",
        reselectInputImage: "Eingabebild erneut auswählen",
        seeAnExample: "Beispiel ansehen",
        orTryExample: "Oder probiere ein Beispielbild",
        dsTitle: "Designservice",
        dsDesc: "Du bist nicht zufrieden mit dem Ergebnis? Schick uns dein Foto und wir erstellen dir kostenlos einen optimierten Mosaik-Vorschlag per E-Mail.",
        dsButton: "Designservice anfragen",

        // Style picker (Step 2)
        stylePickerLabel: "Wähle einen Stil",
        styleOriginal: "Original",
        styleVintage: "Vintage",
        stylePop: "Pop",
        styleWarm: "Warm",
        styleMono: "S/W",

        // Stud map descriptions
        allStudColorsDesc: "Alle Farben, in denen Noppen (1x1 runde Platten) verfügbar sind",
        allTileColorsDesc: "Alle Farben, in denen 1x1 runde Fliesen verfügbar sind",
        allSupportedColorsDesc: "Alle von der Anwendung unterstützten Farben",
        pickABrickDesc: "Alle Farben, in denen Noppen auf der Lego.com Pick a Brick Seite verfügbar sind",

        // Metrics
        usageMetrics: "Nutzungsstatistiken",
        metricsNote: "Hinweis: Es werden keine Benutzerdaten gespeichert, dies sind nur aggregierte Informationen basierend auf einfachen Zählungen",
        date: "Datum",
        imagesCreated: "Erstellte Bilder",

        // PDF content
        pdfLegoMosaic: "BRICKONAS Mosaik",
        pdfFilename: "BRICKONAS-Mosaik",
        pdfInstructions: "Anleitung",
        pdfPart: "Teil",
        pdfResolution: "Auflösung",
        pdfPlates: "Platten",
        pdfPlateSize: "Plattengröße",
        pdfSize: "Größe",
        pdfTotal: "gesamt",
        pdfSection: "Abschnitt",
        pdfDepthInstructions: "Tiefenanleitung",
        pdfDepthPlatingInstructions: "Tiefenplatten-Anleitung",
        pdfLevel: "Ebene",
        pdfColor: "Farbe",
        pdfNoDepthOffset: "Kein Tiefenversatz im Abschnitt",
        pdfOverviewLabel: "Übersicht",

        // Tips section (3D Preview)
        tips: "Tipps",
        previewEffectIntensity: "Vorschau-Effektintensität",
        tipsHelp1: "● Dies ist eine (sehr) grobe Vorschau davon, wie der 3D-Effekt aussehen könnte",
        tipsHelp2: "● Bewegen Sie Ihre Maus über das Bild, um die Perspektive zu ändern",
        tipsHelp3: "● Stellen Sie sicher, dass Ihre Tiefenkarte nicht leer ist",
        tipsHelp4: "● Dies funktioniert wahrscheinlich nicht gut auf weniger leistungsfähigen Geräten, da dies dynamisch generiert wird",
        tipsHelp5: "● Bedenken Sie, dass der Effekt von Browser zu Browser variiert, subtil sein kann und möglicherweise nicht zu 100% repräsentativ für das physische Kunstwerk ist",

        // Depth Plates section
        depthPlates: "Tiefenplatten",
        depthPlatesHelp1: "● Dies ist der Satz von Platten, der verwendet werden kann, um Tiefenanweisungen und Teilelisten zu generieren",
        depthPlatesHelp2: "● Diese Teile werden als Polsterung verwendet, damit die richtigen Pixel nach außen ragen",
        depthPlatesHelp3: "● Beachten Sie, dass größere Platten schwer von der Basis zu befestigen/entfernen sein können",
        availablePlates: "Verfügbare Platten:",

        // Download Instructions section
        downloadInstructionsTitle: "Bauanleitung herunterladen",
        downloadInstructionsDesc: "Lade die Schritt-für-Schritt Bauanleitung als PDF herunter. Bitte speichere die Datei \u2013 sie kann später nicht erneut generiert werden.",
        downloadInstructionsBtn: "Bauanleitung PDF",
        downloadInstructionsHint: "Tipp: Speichere die PDF-Datei an einem sicheren Ort, damit du sie jederzeit wieder verwenden kannst.",

        // New labels for redesign
        advancedSettings: "Erweiterte Einstellungen",
        yourMosaic: "Dein Mosaik",
        imageAndSettings: "Bild & Einstellungen",
    }
};

// Keep English as fallback (alias)
translations.en = translations.de;

// Color translations (Bricklink color names to German)
const colorTranslations = {
    de: {
        "White": "Weiß",
        "Very Light Gray": "Sehr Hellgrau",
        "Very Light Bluish Gray": "Sehr Hell Bläulichgrau",
        "Light Bluish Gray": "Hell Bläulichgrau",
        "Light Gray": "Hellgrau",
        "Dark Gray": "Dunkelgrau",
        "Dark Bluish Gray": "Dunkel Bläulichgrau",
        "Black": "Schwarz",
        "Dark Red": "Dunkelrot",
        "Red": "Rot",
        "Rust": "Rostbraun",
        "Coral": "Koralle",
        "Salmon": "Lachs",
        "Light Salmon": "Helllachs",
        "Sand Red": "Sandrot",
        "Reddish Brown": "Rotbraun",
        "Brown": "Braun",
        "Dark Brown": "Dunkelbraun",
        "Dark Tan": "Dunkel Beige",
        "Tan": "Beige",
        "Light Nougat": "Hell Nougat",
        "Nougat": "Nougat",
        "Medium Nougat": "Mittel Nougat",
        "Dark Nougat": "Dunkel Nougat",
        "Medium Brown": "Mittelbraun",
        "Fabuland Brown": "Fabuland Braun",
        "Fabuland Orange": "Fabuland Orange",
        "Earth Orange": "Erdorange",
        "Dark Orange": "Dunkelorange",
        "Neon Orange": "Neonorange",
        "Orange": "Orange",
        "Medium Orange": "Mittelorange",
        "Bright Light Orange": "Leuchtend Hellorange",
        "Light Orange": "Hellorange",
        "Very Light Orange": "Sehr Hellorange",
        "Dark Yellow": "Dunkelgelb",
        "Yellow": "Gelb",
        "Bright Light Yellow": "Leuchtend Hellgelb",
        "Light Yellow": "Hellgelb",
        "Light Lime": "Hell Limone",
        "Neon Green": "Neongrün",
        "Medium Lime": "Mittel Limone",
        "Lime": "Limone",
        "Olive Green": "Olivgrün",
        "Dark Green": "Dunkelgrün",
        "Green": "Grün",
        "Bright Green": "Leuchtend Grün",
        "Medium Green": "Mittelgrün",
        "Light Green": "Hellgrün",
        "Sand Green": "Sandgrün",
        "Dark Turquoise": "Dunkeltürkis",
        "Light Turquoise": "Helltürkis",
        "Aqua": "Aqua",
        "Light Aqua": "Hellaqua",
        "Dark Blue": "Dunkelblau",
        "Blue": "Blau",
        "Dark Azure": "Dunkel Azur",
        "Medium Azure": "Mittel Azur",
        "Medium Blue": "Mittelblau",
        "Maersk Blue": "Maersk Blau",
        "Bright Light Blue": "Leuchtend Hellblau",
        "Light Blue": "Hellblau",
        "Sky Blue": "Himmelblau",
        "Sand Blue": "Sandblau",
        "Blue-Violet": "Blauviolett",
        "Dark Blue-Violet": "Dunkel Blauviolett",
        "Violet": "Violett",
        "Medium Violet": "Mittelviolett",
        "Light Violet": "Hellviolett",
        "Dark Purple": "Dunkellila",
        "Purple": "Lila",
        "Light Purple": "Helllila",
        "Medium Lavender": "Mittel Lavendel",
        "Clikits Lavender": "Clikits Lavendel",
        "Lavender": "Lavendel",
        "Sand Purple": "Sandlila",
        "Magenta": "Magenta",
        "Dark Pink": "Dunkelrosa",
        "Medium Dark Pink": "Mittel Dunkelrosa",
        "Bright Pink": "Leuchtend Rosa",
        "Pink": "Rosa",
        "Light Pink": "Hellrosa"
    }
};

// Always German
const currentLanguage = 'de';

function translateColor(colorName) {
    return colorTranslations.de[colorName] || colorName;
}

function t(key) {
    return translations.de[key] || key;
}

function updatePageLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        if (translations.de[key]) {
            element.textContent = translations.de[key];
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        const key = element.getAttribute('data-i18n-placeholder');
        if (translations.de[key]) {
            element.placeholder = translations.de[key];
        }
    });

    document.querySelectorAll('[data-i18n-title]').forEach(element => {
        const key = element.getAttribute('data-i18n-title');
        if (translations.de[key]) {
            element.setAttribute('title', translations.de[key]);
        }
    });

    document.title = t('pageTitle');
}

// No-op stubs for backward compatibility
function setLanguage() {}
function updateLanguageSelector() {}

document.addEventListener('DOMContentLoaded', () => {
    updatePageLanguage();
});
