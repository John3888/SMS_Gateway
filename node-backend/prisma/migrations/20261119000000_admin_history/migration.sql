-- CreateTable
CREATE TABLE `RequestRecord` (
    `id` CHAR(36) NOT NULL,
    `application` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `created` DATETIME(3) NOT NULL,
    `updated` DATETIME(3) NOT NULL,

    INDEX `RequestRecord_application_created_idx`(`application`, `created`),
    INDEX `RequestRecord_created_idx`(`created`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RequestEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `requestId` CHAR(36) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `detail` VARCHAR(400) NULL,

    INDEX `RequestEvent_requestId_id_idx`(`requestId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RequestEvent` ADD CONSTRAINT `RequestEvent_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `RequestRecord`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
