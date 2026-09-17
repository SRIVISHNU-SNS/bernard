CREATE TABLE `diagnoses` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int,
  `sessionId` varchar(80) NOT NULL,
  `applianceType` varchar(120) NOT NULL,
  `modelNumber` varchar(160),
  `notes` text,
  `diagnosisJson` text NOT NULL,
  `repairProgress` text NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `diagnoses_id` PRIMARY KEY(`id`)
);
