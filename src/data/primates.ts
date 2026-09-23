import type { TreeNodeInput } from '../tree/types';

export const primateNodes: TreeNodeInput[] = [
  {
    id: 'primates',
    parentId: null,
    scientificName: 'Primates',
    commonName: 'Primates',
    rank: 'Order',
  },

  // Major primate divisions
  {
    id: 'strepsirrhini',
    parentId: 'primates',
    scientificName: 'Strepsirrhini',
    commonName: 'Strepsirrhines',
    rank: 'Suborder',
  },
  {
    id: 'haplorhini',
    parentId: 'primates',
    scientificName: 'Haplorhini',
    commonName: 'Haplorhines',
    rank: 'Suborder',
  },

  // Strepsirrhini
  {
    id: 'lemuriformes',
    parentId: 'strepsirrhini',
    scientificName: 'Lemuriformes',
    commonName: 'Lemurs',
    rank: 'Infraorder',
  },
  {
    id: 'lorisiformes',
    parentId: 'strepsirrhini',
    scientificName: 'Lorisiformes',
    commonName: 'Lorises and galagos',
    rank: 'Infraorder',
  },

  {
    id: 'lemuridae',
    parentId: 'lemuriformes',
    scientificName: 'Lemuridae',
    commonName: 'True lemurs',
    rank: 'Family',
  },
  {
    id: 'indriidae',
    parentId: 'lemuriformes',
    scientificName: 'Indriidae',
    commonName: 'Indris and sifakas',
    rank: 'Family',
  },
  {
    id: 'lemur-catta',
    parentId: 'lemuridae',
    scientificName: 'Lemur catta',
    commonName: 'Ring-tailed lemur',
    rank: 'Species',
  },
  {
    id: 'indri-indri',
    parentId: 'indriidae',
    scientificName: 'Indri indri',
    commonName: 'Indri',
    rank: 'Species',
  },

  {
    id: 'lorisidae',
    parentId: 'lorisiformes',
    scientificName: 'Lorisidae',
    commonName: 'Lorises',
    rank: 'Family',
  },
  {
    id: 'galagidae',
    parentId: 'lorisiformes',
    scientificName: 'Galagidae',
    commonName: 'Galagos',
    rank: 'Family',
  },
  {
    id: 'nycticebus-coucang',
    parentId: 'lorisidae',
    scientificName: 'Nycticebus coucang',
    commonName: 'Sunda slow loris',
    rank: 'Species',
  },
  {
    id: 'galago-senegalensis',
    parentId: 'galagidae',
    scientificName: 'Galago senegalensis',
    commonName: 'Senegal bushbaby',
    rank: 'Species',
  },

  // Haplorhini
  {
    id: 'tarsiiformes',
    parentId: 'haplorhini',
    scientificName: 'Tarsiiformes',
    commonName: 'Tarsiers',
    rank: 'Infraorder',
  },
  {
    id: 'simiiformes',
    parentId: 'haplorhini',
    scientificName: 'Simiiformes',
    commonName: 'Monkeys and apes',
    rank: 'Infraorder',
  },
  {
    id: 'tarsius-tarsier',
    parentId: 'tarsiiformes',
    scientificName: 'Tarsius tarsier',
    commonName: 'Spectral tarsier',
    rank: 'Species',
  },

  // Monkeys and apes
  {
    id: 'platyrrhini',
    parentId: 'simiiformes',
    scientificName: 'Platyrrhini',
    commonName: 'New World monkeys',
    rank: 'Parvorder',
  },
  {
    id: 'catarrhini',
    parentId: 'simiiformes',
    scientificName: 'Catarrhini',
    commonName: 'Old World monkeys and apes',
    rank: 'Parvorder',
  },

  // New World monkeys
  {
    id: 'cebidae',
    parentId: 'platyrrhini',
    scientificName: 'Cebidae',
    commonName: 'Capuchins and squirrel monkeys',
    rank: 'Family',
  },
  {
    id: 'atelidae',
    parentId: 'platyrrhini',
    scientificName: 'Atelidae',
    commonName: 'Howler and spider monkeys',
    rank: 'Family',
  },
  {
    id: 'cebus-capucinus',
    parentId: 'cebidae',
    scientificName: 'Cebus capucinus',
    commonName: 'White-faced capuchin',
    rank: 'Species',
  },
  {
    id: 'ateles-geoffroyi',
    parentId: 'atelidae',
    scientificName: 'Ateles geoffroyi',
    commonName: "Geoffroy's spider monkey",
    rank: 'Species',
  },

  // Catarrhini
  {
    id: 'cercopithecoidea',
    parentId: 'catarrhini',
    scientificName: 'Cercopithecoidea',
    commonName: 'Old World monkeys',
    rank: 'Superfamily',
  },
  {
    id: 'hominoidea',
    parentId: 'catarrhini',
    scientificName: 'Hominoidea',
    commonName: 'Apes',
    rank: 'Superfamily',
  },

  {
    id: 'cercopithecidae',
    parentId: 'cercopithecoidea',
    scientificName: 'Cercopithecidae',
    commonName: 'Old World monkeys',
    rank: 'Family',
  },
  {
    id: 'macaca-mulatta',
    parentId: 'cercopithecidae',
    scientificName: 'Macaca mulatta',
    commonName: 'Rhesus macaque',
    rank: 'Species',
  },
  {
    id: 'papio-anubis',
    parentId: 'cercopithecidae',
    scientificName: 'Papio anubis',
    commonName: 'Olive baboon',
    rank: 'Species',
  },

  // Apes
  {
    id: 'hylobatidae',
    parentId: 'hominoidea',
    scientificName: 'Hylobatidae',
    commonName: 'Gibbons',
    rank: 'Family',
  },
  {
    id: 'hominidae',
    parentId: 'hominoidea',
    scientificName: 'Hominidae',
    commonName: 'Great apes',
    rank: 'Family',
  },
  {
    id: 'hylobates-lar',
    parentId: 'hylobatidae',
    scientificName: 'Hylobates lar',
    commonName: 'Lar gibbon',
    rank: 'Species',
  },

  // Great apes
  {
    id: 'ponginae',
    parentId: 'hominidae',
    scientificName: 'Ponginae',
    commonName: 'Orangutans',
    rank: 'Subfamily',
  },
  {
    id: 'homininae',
    parentId: 'hominidae',
    scientificName: 'Homininae',
    commonName: 'African apes and humans',
    rank: 'Subfamily',
  },

  {
    id: 'pongo',
    parentId: 'ponginae',
    scientificName: 'Pongo',
    commonName: 'Orangutans',
    rank: 'Genus',
  },
  {
    id: 'pongo-pygmaeus',
    parentId: 'pongo',
    scientificName: 'Pongo pygmaeus',
    commonName: 'Bornean orangutan',
    rank: 'Species',
  },

  {
    id: 'gorillini',
    parentId: 'homininae',
    scientificName: 'Gorillini',
    commonName: 'Gorillas',
    rank: 'Tribe',
  },
  {
    id: 'hominini',
    parentId: 'homininae',
    scientificName: 'Hominini',
    commonName: 'Chimpanzees and humans',
    rank: 'Tribe',
  },

  {
    id: 'gorilla',
    parentId: 'gorillini',
    scientificName: 'Gorilla',
    commonName: 'Gorillas',
    rank: 'Genus',
  },
  {
    id: 'gorilla-gorilla',
    parentId: 'gorilla',
    scientificName: 'Gorilla gorilla',
    commonName: 'Western gorilla',
    rank: 'Species',
  },

  {
    id: 'pan',
    parentId: 'hominini',
    scientificName: 'Pan',
    commonName: 'Chimpanzees and bonobos',
    rank: 'Genus',
  },
  {
    id: 'homo',
    parentId: 'hominini',
    scientificName: 'Homo',
    commonName: 'Humans',
    rank: 'Genus',
  },

  {
    id: 'pan-troglodytes',
    parentId: 'pan',
    scientificName: 'Pan troglodytes',
    commonName: 'Chimpanzee',
    rank: 'Species',
  },
  {
    id: 'pan-paniscus',
    parentId: 'pan',
    scientificName: 'Pan paniscus',
    commonName: 'Bonobo',
    rank: 'Species',
  },
  {
    id: 'homo-sapiens',
    parentId: 'homo',
    scientificName: 'Homo sapiens',
    commonName: 'Human',
    rank: 'Species',
  },
];