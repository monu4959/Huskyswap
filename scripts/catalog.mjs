// Item templates shared by generate-synthetic.mjs and fetch-images.mjs.
// k: photo key (one set of photos per key), q: Openverse search phrase,
// sale / rent: [min, max] dollars (rent is the price for one week).

const COURSES = [
  ["Calculus: Early Transcendentals", "MATH 1341", "math"],
  ["Linear Algebra and Its Applications", "MATH 2331", "math"],
  ["Discrete Mathematics", "CS 1800", "math"],
  ["Fundamentals of Physics", "PHYS 1151", "physics"],
  ["Organic Chemistry", "CHEM 2311", "chemistry"],
  ["Campbell Biology", "BIOL 1111", "biology"],
  ["How to Design Programs", "CS 2500", "programming"],
  ["Introduction to Algorithms", "CS 5800", "programming"],
  ["Principles of Microeconomics", "ECON 1115", "economics"],
  ["Principles of Macroeconomics", "ECON 1116", "economics"],
  ["Psychology: Themes and Variations", "PSYC 1101", "psychology"],
  ["Statistics for Business", "MGSC 2301", "business"],
  ["Financial Accounting", "ACCT 1201", "business"],
  ["Marketing Management", "MKTG 2201", "business"],
  ["Engineering Mechanics: Statics", "GE 1501", "engineering"],
];

const TEXTBOOK_QUERY = {
  math: "math textbook",
  physics: "physics textbook",
  chemistry: "chemistry textbook",
  biology: "biology textbook",
  programming: "programming book",
  economics: "economics textbook",
  psychology: "psychology textbook",
  business: "business textbook",
  engineering: "engineering textbook",
};

export function makeCatalog(pick) {
  return {
    textbooks: {
      weight: 18, rentP: 0.55,
      items: COURSES.map(([book, course, subject]) => ({
        k: `textbook-${subject}`, q: TEXTBOOK_QUERY[subject],
        t: () => `${book}, ${pick(["8th", "9th", "10th", "11th", "4th", "5th"])} ed.`,
        d: [`Used for ${course}.`, `Required for ${course} last semester.`, `Bought for ${course}, barely opened after the first month.`],
        sale: [18, 85], rent: [4, 12],
      })),
    },
    electronics: {
      weight: 17, rentP: 0.4,
      items: [
        { k: "graphing-calculator", q: "graphing calculator", t: "TI-84 Plus CE graphing calculator", d: ["Charging cable included.", "Works perfectly, allowed on most exams."], sale: [55, 90], rent: [5, 10] },
        { k: "ipad", q: "ipad", t: () => `iPad ${pick(["9th gen", "Air (4th gen)", "10th gen"])}, ${pick(["64", "128", "256"])} GB`, d: ["Comes with a case.", "Screen protector since day one."], sale: [180, 380], rent: [20, 35] },
        { k: "monitor", q: "computer monitor", t: () => `${pick(["Dell", "LG", "Samsung", "ASUS"])} ${pick([24, 27])}" monitor`, d: ["HDMI cable included.", "Great second screen for coding."], sale: [60, 160], rent: [10, 18] },
        { k: "earbuds", q: "airpods", t: "AirPods Pro (2nd gen)", d: ["New ear tips, case has a small scuff.", "Sanitized and fully working."], sale: [90, 150], rent: null },
        { k: "keyboard", q: "computer keyboard", t: () => `${pick(["Logitech MX Keys", "Keychron K2", "Apple Magic"])} keyboard`, d: ["Bluetooth, all keys work.", "Clean, from a smoke-free room."], sale: [35, 80], rent: [5, 10] },
        { k: "game-console", q: "nintendo switch", t: "Nintendo Switch OLED", d: ["Two Joy-Cons and the dock.", "Includes Mario Kart 8."], sale: [210, 270], rent: [18, 30] },
        { k: "speaker", q: "bluetooth speaker", t: () => `${pick(["JBL Flip 6", "UE Boom 3", "Bose SoundLink Flex"])} speaker`, d: ["Loud enough for a suite.", "Battery still lasts all day."], sale: [50, 100], rent: [8, 14] },
        { k: "camera", q: "dslr camera", t: "Canon EOS Rebel T7 with kit lens", d: ["Two batteries and a 64 GB card.", "Good for a photo class or portfolio shoot."], sale: [260, 360], rent: [25, 40] },
        { k: "ereader", q: "kindle", t: () => `${pick(["Kindle Paperwhite", "Kobo Clara"])} e-reader`, d: ["Backlight works great.", "Comes with a cover."], sale: [45, 90], rent: [5, 9] },
        { k: "ring-light", q: "ring light", t: "Ring light with tripod stand", d: ["Three color modes, USB powered.", "Good for co-op video interviews."], sale: [15, 35], rent: [3, 6] },
        { k: "drawing-tablet", q: "wacom tablet", t: "Wacom drawing tablet with pen", d: ["Pen and nibs included.", "Used for one design studio."], sale: [40, 90], rent: [6, 12] },
      ],
    },
    furniture: {
      weight: 12, rentP: 0.08,
      items: [
        { k: "desk", q: "wooden desk", t: () => `IKEA ${pick(["Malm", "Micke", "Linnmon", "Alex"])} desk`, d: ["You'll need a cart or a friend to carry it.", "Disassembled and ready to go."], sale: [25, 70], rent: null },
        { k: "office-chair", q: "office chair", t: "Ergonomic office chair", d: ["Adjustable height and lumbar support.", "Way better than the dorm chair."], sale: [35, 90], rent: [8, 15] },
        { k: "bookshelf", q: "bookshelf", t: () => `${pick(["5-shelf", "3-shelf", "Cube"])} bookshelf`, d: ["Sturdy, no wobble.", "Fits in a dorm corner."], sale: [15, 45], rent: null },
        { k: "futon", q: "futon", t: "Futon that folds into a bed", d: ["Cover is washable.", "Perfect for a common room."], sale: [60, 140], rent: null },
        { k: "floor-lamp", q: "floor lamp", t: "Floor lamp with reading arm", d: ["Warm LED bulb included.", "Much better than overhead light."], sale: [10, 25], rent: null },
        { k: "bean-bag", q: "bean bag", t: "Bean bag chair, XL", d: ["Refilled last semester.", "Super comfy for movie nights."], sale: [20, 50], rent: null },
        { k: "nightstand", q: "nightstand", t: "Bedside table with drawer", d: ["Light wood finish.", "Minor scratches on top."], sale: [10, 30], rent: null },
        { k: "mirror", q: "full length mirror", t: "Full-length mirror", d: ["Over-the-door or leaning.", "No cracks."], sale: [8, 20], rent: null },
      ],
    },
    kitchen: {
      weight: 9, rentP: 0.25,
      items: [
        { k: "instant-pot", q: "instant pot", t: "Instant Pot Duo, 6 qt", d: ["All parts included.", "Makes dorm cooking much easier."], sale: [30, 55], rent: [5, 9] },
        { k: "air-fryer", q: "air fryer", t: () => `${pick(["Ninja", "Cosori", "Instant Vortex"])} air fryer`, d: ["Basket is clean.", "Fits a small counter."], sale: [30, 65], rent: [5, 9] },
        { k: "kettle", q: "electric kettle", t: "Electric kettle", d: ["Boils in about two minutes.", "Auto shut-off works."], sale: [8, 18], rent: null },
        { k: "rice-cooker", q: "rice cooker", t: "Rice cooker, 6 cup", d: ["Includes the measuring cup and paddle.", "Non-stick pot in good shape."], sale: [12, 30], rent: null },
        { k: "cookware", q: "pots and pans", t: "Pots and pans starter set", d: ["Five pieces with lids.", "Good for a first apartment."], sale: [20, 45], rent: null },
        { k: "coffee-maker", q: "coffee maker", t: "Keurig K-Mini coffee maker", d: ["Descaled recently.", "Single-serve, fits anywhere."], sale: [25, 45], rent: null },
        { k: "stand-mixer", q: "kitchenaid mixer", t: "Stand mixer (KitchenAid Artisan)", d: ["Bowl and three attachments.", "Bakes like new."], sale: [140, 220], rent: [12, 20] },
        { k: "blender", q: "blender", t: "Blender (NutriBullet)", d: ["Two cups included.", "Smoothies every morning."], sale: [20, 40], rent: [4, 6] },
      ],
    },
    clothing: {
      weight: 9, rentP: 0.12,
      items: [
        { k: "puffer-jacket", q: "puffer jacket", t: () => `${pick(["Patagonia Nano Puff", "North Face Nuptse", "Uniqlo Ultra Light Down"])} jacket, ${pick(["S", "M", "L"])}`, d: ["Warm enough for a Boston winter.", "No rips or stains."], sale: [40, 140], rent: null },
        { k: "suit", q: "navy suit", t: () => `Navy suit, ${pick(["38R", "40R", "42R"])}`, d: ["Worn twice for interviews.", "Dry cleaned."], sale: [60, 120], rent: [15, 25] },
        { k: "winter-boots", q: "winter boots", t: () => `Winter boots, size ${pick([7, 8, 9, 10, 11])}`, d: ["Waterproof, great for slush.", "Treads still good."], sale: [30, 70], rent: null },
        { k: "hoodie", q: "hoodie", t: () => `Northeastern hoodie, ${pick(["S", "M", "L", "XL"])}`, d: ["From the bookstore.", "Washed and folded."], sale: [15, 30], rent: null },
        { k: "blazer", q: "blazer", t: () => `Blazer, ${pick(["S", "M", "L"])}`, d: ["Good for co-op interviews.", "Black, fully lined."], sale: [25, 55], rent: [6, 12] },
        { k: "costume", q: "halloween costume", t: "Halloween costume set", d: ["Complete set with accessories.", "Worn once."], sale: [10, 25], rent: [4, 8] },
      ],
    },
    dorm_essentials: {
      weight: 13, rentP: 0.15,
      items: [
        { k: "mini-fridge", q: "mini fridge", t: "Mini fridge, 3.1 cu ft", d: ["Freezer compartment works.", "Clean inside, no smells."], sale: [45, 90], rent: null },
        { k: "microwave", q: "microwave oven", t: "Microwave, 0.7 cu ft", d: ["Turntable included.", "Fits on a dresser."], sale: [25, 50], rent: null },
        { k: "mattress-topper", q: "mattress", t: "Twin XL mattress topper, 3 in", d: ["Memory foam, in a cover.", "Makes the dorm bed bearable."], sale: [20, 45], rent: null },
        { k: "bedding", q: "bed sheets", t: "Twin XL sheet set", d: ["Washed and folded.", "Grey, fits standard dorm mattresses."], sale: [8, 18], rent: null },
        { k: "fan", q: "electric fan", t: "Box fan", d: ["Three speeds.", "Essential for September in West Village."], sale: [10, 22], rent: [3, 5] },
        { k: "space-heater", q: "space heater", t: "Space heater", d: ["Tip-over shut-off.", "Quiet enough to sleep with."], sale: [15, 35], rent: [4, 7] },
        { k: "shoe-rack", q: "shoe rack", t: "Over-the-door shoe rack", d: ["Holds 24 pairs.", "All hooks included."], sale: [5, 12], rent: null },
        { k: "shower-caddy", q: "towels", t: "Shower caddy and robe", d: ["Caddy has a handle.", "Robe washed."], sale: [6, 15], rent: null },
        { k: "iron", q: "ironing board", t: "Steam iron and board", d: ["Board folds flat.", "For interview mornings."], sale: [12, 28], rent: [3, 6] },
        { k: "vacuum", q: "vacuum cleaner", t: "Vacuum (Bissell stick)", d: ["Battery holds a charge.", "Good for carpets and hard floors."], sale: [30, 60], rent: [5, 9] },
      ],
    },
    sports_outdoors: {
      weight: 9, rentP: 0.6,
      items: [
        { k: "tent", q: "camping tent", t: "2-person backpacking tent", d: ["All stakes and the rainfly.", "Great for a weekend in the White Mountains."], sale: [50, 110], rent: [10, 18] },
        { k: "dumbbells", q: "dumbbells", t: "Adjustable dumbbells, 5–25 lb pair", d: ["Dial adjusts in 2.5 lb steps.", "For when Marino is packed."], sale: [70, 120], rent: [8, 14] },
        { k: "snowboard", q: "snowboard", t: () => `Snowboard with bindings, ${pick([148, 152, 155, 158])} cm`, d: ["Waxed this fall.", "Boots not included."], sale: [90, 200], rent: [20, 35] },
        { k: "ski-boots", q: "ski boots", t: () => `Ski boots, size ${pick([26, 27, 28, 29])}`, d: ["Liners in good shape.", "Fit true to size."], sale: [50, 110], rent: [12, 20] },
        { k: "yoga-mat", q: "yoga mat", t: "Yoga mat and blocks", d: ["Non-slip, 6 mm.", "Cleaned and rolled."], sale: [10, 25], rent: [3, 5] },
        { k: "hiking-backpack", q: "hiking backpack", t: "Hiking backpack, 40 L", d: ["Rain cover included.", "Comfortable hip belt."], sale: [35, 80], rent: [8, 14] },
        { k: "tennis-racket", q: "tennis racket", t: "Tennis racket (Wilson)", d: ["Restrung recently.", "Comes with three balls."], sale: [25, 60], rent: [5, 8] },
        { k: "sleeping-bag", q: "sleeping bag", t: "Sleeping bag, rated 30°F", d: ["Compression sack included.", "Washed after the last trip."], sale: [30, 70], rent: [6, 10] },
        { k: "ice-skates", q: "ice skates", t: "Ice skates, size 9", d: ["Sharpened last season.", "Frog Pond ready."], sale: [25, 50], rent: [5, 9] },
      ],
    },
    bikes_transport: {
      weight: 7, rentP: 0.5,
      items: [
        { k: "hybrid-bike", q: "hybrid bike", t: () => `${pick(["Trek FX 2", "Giant Escape 3", "Specialized Sirrus", "Cannondale Quick"])} hybrid bike, ${pick(["S", "M", "L"])}`, d: ["Tuned up recently.", "Rides great on the Southwest Corridor."], sale: [180, 380], rent: [18, 30] },
        { k: "road-bike", q: "road bike", t: () => `Road bike, ${pick([52, 54, 56, 58])} cm`, d: ["Shimano Claris groupset.", "New tires this spring."], sale: [220, 450], rent: [20, 35] },
        { k: "bike-lock", q: "bike lock", t: "Kryptonite U-lock with cable", d: ["Two keys.", "Don't leave a bike on campus without one."], sale: [25, 45], rent: null },
        { k: "scooter", q: "electric scooter", t: () => `Electric scooter (${pick(["Segway Ninebot", "Hiboy S2"])})`, d: ["Range about 12 miles.", "Charger included."], sale: [200, 380], rent: [25, 40] },
        { k: "helmet", q: "bike helmet", t: "Bike helmet and lights set", d: ["Front and rear USB lights.", "Helmet fits M."], sale: [20, 40], rent: [4, 7] },
        { k: "folding-bike", q: "folding bike", t: "Folding bike (Brompton-style)", d: ["Fits under a desk.", "Perfect for T plus bike commutes."], sale: [250, 500], rent: [25, 40] },
      ],
    },
    other: {
      weight: 6, rentP: 0.5,
      items: [
        { k: "board-game", q: "board game", t: () => `${pick(["Catan", "Ticket to Ride", "Codenames", "Monopoly Deal"])} board game`, d: ["All pieces counted.", "Great for floor game night."], sale: [10, 35], rent: [3, 6] },
        { k: "guitar", q: "acoustic guitar", t: "Acoustic guitar (Yamaha FG800)", d: ["New strings, gig bag included.", "Great for beginners."], sale: [90, 160], rent: [12, 20] },
        { k: "projector", q: "projector", t: "Portable projector", d: ["1080p, HDMI and USB-C.", "Movie nights on a wall."], sale: [60, 140], rent: [12, 20] },
        { k: "luggage", q: "suitcase", t: "Luggage set, 2 pieces", d: ["Spinner wheels.", "Used for one study abroad trip."], sale: [40, 90], rent: [8, 15] },
        { k: "sewing-machine", q: "sewing machine", t: "Sewing machine (Brother)", d: ["Comes with bobbins and needles.", "Works smoothly."], sale: [50, 100], rent: [8, 14] },
        { k: "houseplants", q: "houseplant", t: "Plant collection: pothos and snake plant", d: ["Pots included.", "Very hard to kill."], sale: [8, 25], rent: null },
      ],
    },
  };
}

// Every photo key and its search phrase, deduplicated
export function photoQueries() {
  const map = new Map();
  for (const cat of Object.values(makeCatalog((a) => a[0]))) for (const it of cat.items) map.set(it.k, it.q);
  return map;
}
